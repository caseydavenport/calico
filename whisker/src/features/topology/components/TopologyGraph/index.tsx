import React from 'react';
import * as d3 from 'd3';
import {
    buildTopologyGraph,
    formatBytes,
    TopologyNode,
    TopologyEdge,
} from '../../utils/buildTopologyGraph';
import { FlowLog } from '@/types/render';
import { Box, Text, Flex, Table, Thead, Tbody, Tr, Th, Td } from '@chakra-ui/react';
import { AnimatePresence, motion } from 'framer-motion';

const MotionBox = motion(Box);

type Props = {
    flows: FlowLog[];
    width?: number;
    height?: number;
    highlightSrc?: string;
    highlightDst?: string;
};

type SimNode = TopologyNode & d3.SimulationNodeDatum;
type SimEdge = Omit<TopologyEdge, 'source' | 'target'> & {
    source: SimNode;
    target: SimNode;
};

const ACTION_COLORS: Record<string, string> = {
    Allow: '#38A169',
    Deny: '#E53E3E',
    Pass: '#3182CE',
    Mixed: '#D69E2E',
};

const NAMESPACE_COLORS = [
    '#2B6CB0', '#38A169', '#D69E2E', '#9F7AEA',
    '#ED64A6', '#DD6B20', '#319795', '#E53E3E',
];

const EXTERNAL_COLOR = '#718096';

const cleanName = (name: string) =>
    name.replace(/-[a-z0-9]{6,10}-\*$/, '-*');

const TopologyGraph: React.FC<Props> = ({
    flows,
    width = 900,
    height = 600,
    highlightSrc,
    highlightDst,
}) => {
    const svgRef = React.useRef<SVGSVGElement>(null);
    const [nodes, setNodes] = React.useState<SimNode[]>([]);
    const [edges, setEdges] = React.useState<SimEdge[]>([]);
    const [hoveredNode, setHoveredNode] = React.useState<string | null>(null);
    const [selectedNode, setSelectedNode] = React.useState<string | null>(null);
    const [tooltipContent, setTooltipContent] = React.useState('');
    const [tooltipPos, setTooltipPos] = React.useState({ x: 0, y: 0 });
    const [transform, setTransform] = React.useState(d3.zoomIdentity);
    const simulationRef = React.useRef<d3.Simulation<SimNode, SimEdge>>();

    const graph = React.useMemo(
        () => buildTopologyGraph(flows || []),
        [flows],
    );

    // Namespace color map
    const nsColors = React.useMemo(() => {
        if (!graph || graph.nodes.length === 0) return new Map<string, string>();
        const namespaces = [...new Set(graph.nodes.map((n) => n.namespace))];
        const colorMap = new Map<string, string>();
        namespaces.forEach((ns, i) => {
            colorMap.set(ns, NAMESPACE_COLORS[i % NAMESPACE_COLORS.length]);
        });
        return colorMap;
    }, [graph]);

    const maxBytes = React.useMemo(
        () =>
            graph && graph.edges.length > 0
                ? Math.max(...graph.edges.map((e) => e.bytes), 1)
                : 1,
        [graph],
    );

    // Selected node flows
    const selectedFlows = React.useMemo(() => {
        if (!selectedNode || !flows) return [];
        return flows.filter((f) => {
            const srcId = `${f.source_namespace || '_external_'}/${f.source_name}`;
            const dstId = `${f.dest_namespace || '_external_'}/${f.dest_name}`;
            return srcId === selectedNode || dstId === selectedNode;
        });
    }, [selectedNode, flows]);

    // D3 simulation — preserve node positions across data updates
    const prevNodesRef = React.useRef(new Map<string, { x: number; y: number }>());

    React.useEffect(() => {
        if (graph.nodes.length === 0) return;

        const prev = prevNodesRef.current;
        const simNodes: SimNode[] = graph.nodes.map((n) => {
            const saved = prev.get(n.id);
            return {
                ...n,
                x: saved?.x ?? width / 2 + (Math.random() - 0.5) * 300,
                y: saved?.y ?? height / 2 + (Math.random() - 0.5) * 300,
            };
        });

        const nodeMap = new Map(simNodes.map((n) => [n.id, n]));
        const simEdges: SimEdge[] = graph.edges
            .map((e) => ({
                ...e,
                source: nodeMap.get(e.source)!,
                target: nodeMap.get(e.target)!,
            }))
            .filter((e) => e.source && e.target);

        // Namespace clustering force
        const nsPositions = new Map<string, { x: number; y: number; count: number }>();
        for (const n of simNodes) {
            const ns = n.namespace;
            const pos = nsPositions.get(ns) || { x: 0, y: 0, count: 0 };
            pos.x += n.x!;
            pos.y += n.y!;
            pos.count++;
            nsPositions.set(ns, pos);
        }

        const simulation = d3
            .forceSimulation<SimNode>(simNodes)
            .force(
                'link',
                d3.forceLink<SimNode, SimEdge>(simEdges)
                    .id((d) => d.id)
                    .distance(120),
            )
            .force('charge', d3.forceManyBody().strength(-400))
            .force('center', d3.forceCenter(width / 2, height / 2))
            .force('collision', d3.forceCollide().radius(40))
            // Gentle namespace clustering
            .force('cluster', () => {
                for (const node of simNodes) {
                    const ns = nsPositions.get(node.namespace);
                    if (ns && ns.count > 1) {
                        const cx = ns.x / ns.count;
                        const cy = ns.y / ns.count;
                        node.vx! += (cx - node.x!) * 0.005;
                        node.vy! += (cy - node.y!) * 0.005;
                    }
                }
            })
            .alphaDecay(0.03);

        simulationRef.current = simulation;

        simulation.on('tick', () => {
            // Save positions for next update
            for (const n of simNodes) {
                prevNodesRef.current.set(n.id, { x: n.x!, y: n.y! });
            }
            setNodes([...simNodes]);
            setEdges([...simEdges]);
        });

        return () => { simulation.stop(); };
    }, [graph, width, height]);

    // Zoom
    React.useEffect(() => {
        if (!svgRef.current) return;
        const svg = svgRef.current;

        const zoom = d3.zoom<SVGSVGElement, unknown>()
            .scaleExtent([0.2, 4])
            .on('zoom', (event) => setTransform(event.transform));

        d3.select(svg).call(zoom);

        // Click handler for node selection (bypasses D3 zoom)
        const handleClick = (e: MouseEvent) => {
            const target = e.target as SVGElement;
            const nodeId = target.closest('[data-node-id]')?.getAttribute('data-node-id');
            if (nodeId) {
                setSelectedNode((prev) => prev === nodeId ? null : nodeId);
            } else if (target === svg || target.tagName === 'rect') {
                setSelectedNode(null);
            }
        };
        svg.addEventListener('click', handleClick);
        return () => svg.removeEventListener('click', handleClick);
    }, []);

    // Auto-select from highlight params
    const didAutoSelect = React.useRef(false);
    React.useEffect(() => {
        if (didAutoSelect.current || !highlightSrc || nodes.length === 0) return;
        const node = nodes.find((n) => n.id === highlightSrc);
        if (node) {
            setSelectedNode(node.id);
            didAutoSelect.current = true;
        }
    }, [nodes, highlightSrc, highlightDst]);

    // Rendering helpers
    const nodeRadius = (node: SimNode) => {
        const minR = 10;
        const maxR = 30;
        const maxNodeBytes = Math.max(...nodes.map((n) => n.totalBytes), 1);
        return minR + (node.totalBytes / maxNodeBytes) * (maxR - minR);
    };

    const edgeWidth = (edge: SimEdge) =>
        Math.max(1.5, (edge.bytes / maxBytes) * 8);

    if (graph.nodes.length === 0) {
        return (
            <Flex align='center' justify='center' h={height} color='gray.500'>
                <Text fontFamily='monospace'>No flow data available.</Text>
            </Flex>
        );
    }

    const activeNode = hoveredNode || selectedNode;

    const isNodeHighlighted = (nodeId: string) => {
        if (!activeNode) return true;
        if (nodeId === activeNode) return true;
        return edges.some(
            (e) =>
                (e.source.id === activeNode && e.target.id === nodeId) ||
                (e.target.id === activeNode && e.source.id === nodeId),
        );
    };

    const isEdgeHighlighted = (edge: SimEdge) => {
        if (!activeNode) return true;
        return edge.source.id === activeNode || edge.target.id === activeNode;
    };

    const selectedNodeObj = nodes.find((n) => n.id === selectedNode);

    // Curved edge path
    const edgePath = (edge: SimEdge) => {
        const dx = edge.target.x! - edge.source.x!;
        const dy = edge.target.y! - edge.source.y!;
        const dr = Math.sqrt(dx * dx + dy * dy) * 1.5;
        return `M${edge.source.x},${edge.source.y} A${dr},${dr} 0 0,1 ${edge.target.x},${edge.target.y}`;
    };

    // Arrow marker at 60% along edge
    const arrowPos = (edge: SimEdge) => {
        const t = 0.6;
        return {
            x: edge.source.x! + (edge.target.x! - edge.source.x!) * t,
            y: edge.source.y! + (edge.target.y! - edge.source.y!) * t,
        };
    };

    return (
        <Box position='relative' h='100%'>
            <svg
                ref={svgRef}
                width={width}
                height={height}
                style={{ background: '#1A202C' }}
            >
                {/* Background click target */}
                <rect width={width} height={height} fill='transparent' />

                <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
                    {/* Namespace hulls */}
                    {(() => {
                        const nsByNs = new Map<string, SimNode[]>();
                        for (const n of nodes) {
                            if (n.type === 'external') continue;
                            const arr = nsByNs.get(n.namespace) || [];
                            arr.push(n);
                            nsByNs.set(n.namespace, arr);
                        }
                        return Array.from(nsByNs.entries()).map(([ns, nsNodes]) => {
                            if (nsNodes.length < 2) return null;
                            const padding = 50;
                            const xs = nsNodes.map((n) => n.x!);
                            const ys = nsNodes.map((n) => n.y!);
                            const x0 = Math.min(...xs) - padding;
                            const y0 = Math.min(...ys) - padding;
                            const x1 = Math.max(...xs) + padding;
                            const y1 = Math.max(...ys) + padding;
                            const color = nsColors.get(ns) || '#4A5568';
                            return (
                                <g key={`hull-${ns}`}>
                                    <rect
                                        x={x0} y={y0}
                                        width={x1 - x0} height={y1 - y0}
                                        rx={12}
                                        fill={color}
                                        fillOpacity={0.06}
                                        stroke={color}
                                        strokeOpacity={0.15}
                                        strokeWidth={1}
                                    />
                                    <text
                                        x={x0 + 8} y={y0 + 14}
                                        fontSize={10}
                                        fill={color}
                                        fontFamily='monospace'
                                        fontWeight='bold'
                                        opacity={0.5}
                                    >
                                        {ns}
                                    </text>
                                </g>
                            );
                        });
                    })()}

                    {/* Edges */}
                    <g>
                        {edges.map((edge) => {
                            const highlighted = isEdgeHighlighted(edge);
                            const color = ACTION_COLORS[edge.action] || '#A0AEC0';
                            const w = edgeWidth(edge);
                            return (
                                <g key={edge.id}>
                                    <path
                                        d={edgePath(edge)}
                                        fill='none'
                                        stroke={color}
                                        strokeWidth={w}
                                        strokeOpacity={highlighted ? 0.6 : 0.06}
                                        strokeDasharray={edge.action === 'Deny' ? '6,3' : undefined}
                                        style={{ transition: 'stroke-opacity 0.2s ease' }}
                                    />
                                    {/* Direction indicator */}
                                    <circle
                                        cx={arrowPos(edge).x}
                                        cy={arrowPos(edge).y}
                                        r={Math.max(2, w * 0.6)}
                                        fill={color}
                                        opacity={highlighted ? 0.8 : 0.06}
                                        style={{ transition: 'opacity 0.2s ease' }}
                                    />
                                </g>
                            );
                        })}
                    </g>

                    {/* Nodes */}
                    <g>
                        {nodes.map((node) => {
                            const r = nodeRadius(node);
                            const isExternal = node.type === 'external';
                            const color = isExternal
                                ? EXTERNAL_COLOR
                                : nsColors.get(node.namespace) || '#718096';
                            const highlighted = isNodeHighlighted(node.id);
                            const isSelected = selectedNode === node.id;
                            const isHovered = hoveredNode === node.id;

                            return (
                                <g
                                    key={node.id}
                                    data-node-id={node.id}
                                    transform={`translate(${node.x},${node.y})`}
                                    opacity={highlighted ? 1 : 0.15}
                                    style={{ transition: 'opacity 0.2s ease', cursor: 'pointer' }}
                                    onMouseEnter={(e) => {
                                        setHoveredNode(node.id);
                                        setTooltipContent(
                                            `${node.name}\n${node.namespace}\n${formatBytes(node.totalBytes)}`,
                                        );
                                        setTooltipPos({ x: e.clientX, y: e.clientY });
                                    }}
                                    onMouseLeave={() => {
                                        setHoveredNode(null);
                                        setTooltipContent('');
                                    }}
                                >
                                    {/* External nodes: diamond shape */}
                                    {isExternal ? (
                                        <rect
                                            x={-r * 0.7} y={-r * 0.7}
                                            width={r * 1.4} height={r * 1.4}
                                            rx={4}
                                            transform='rotate(45)'
                                            fill={EXTERNAL_COLOR}
                                            stroke={isSelected || isHovered ? '#FFF' : 'rgba(255,255,255,0.2)'}
                                            strokeWidth={isSelected ? 2.5 : isHovered ? 2 : 1}
                                        />
                                    ) : (
                                        <circle
                                            r={r}
                                            fill={color}
                                            stroke={isSelected || isHovered ? '#FFF' : 'rgba(255,255,255,0.15)'}
                                            strokeWidth={isSelected ? 2.5 : isHovered ? 2 : 1}
                                        />
                                    )}
                                    {/* Node label */}
                                    <text
                                        dy={r + 14}
                                        textAnchor='middle'
                                        fontSize={11}
                                        fill='#E2E8F0'
                                        fontFamily='monospace'
                                        fontWeight={isSelected ? 'bold' : '600'}
                                    >
                                        {cleanName(node.name)}
                                    </text>
                                    <text
                                        dy={r + 25}
                                        textAnchor='middle'
                                        fontSize={9}
                                        fill='#A0AEC0'
                                        fontFamily='monospace'
                                    >
                                        {node.namespace}
                                    </text>
                                </g>
                            );
                        })}
                    </g>
                </g>
            </svg>

            {/* Tooltip */}
            {tooltipContent && (
                <Box
                    position='fixed'
                    left={tooltipPos.x + 14}
                    top={tooltipPos.y - 24}
                    bg='gray.900' color='white' px={3} py={1.5}
                    borderRadius='lg' fontSize='xs' fontFamily='monospace'
                    pointerEvents='none' zIndex={1000} whiteSpace='pre-line'
                    border='1px solid' borderColor='gray.600' boxShadow='lg'
                >
                    {tooltipContent}
                </Box>
            )}

            {/* Legend */}
            <Flex
                position='absolute' bottom={4} left={4}
                bg='rgba(26, 32, 44, 0.9)' borderRadius='md'
                px={3} py={2} gap={4} fontSize='xs' color='gray.300'
                fontFamily='monospace'
            >
                {Object.entries(ACTION_COLORS).map(([action, color]) => (
                    <Flex key={action} align='center' gap={1.5}>
                        <Box w='10px' h='10px' borderRadius={action === 'Mixed' ? 'sm' : 'full'} bg={color} />
                        <Text>{action}</Text>
                    </Flex>
                ))}
                <Flex align='center' gap={1.5}>
                    <Box w='10px' h='10px' borderRadius='sm' bg={EXTERNAL_COLOR} transform='rotate(45deg)' />
                    <Text>External</Text>
                </Flex>
            </Flex>

            {/* Namespace legend */}
            <Flex
                position='absolute' top={4} right={4}
                bg='rgba(26, 32, 44, 0.9)' borderRadius='md'
                px={3} py={2} gap={2} flexDirection='column'
                fontSize='xs' color='gray.300' fontFamily='monospace'
            >
                <Text color='gray.500' fontWeight='bold' fontSize='10px'>NAMESPACES</Text>
                {Array.from(nsColors.entries()).map(([ns, color]) => (
                    <Flex key={ns} align='center' gap={1.5}>
                        <Box w='8px' h='8px' borderRadius='full' bg={color} />
                        <Text>{ns}</Text>
                    </Flex>
                ))}
            </Flex>

            {/* Selected node detail panel */}
            <AnimatePresence>
                {selectedNodeObj && (
                    <MotionBox
                        position='fixed' bottom={0} left={0} right={0}
                        bg='gray.800' borderTop='1px solid' borderColor='gray.600'
                        p={5} maxH='35vh' overflowY='auto'
                        initial={{ y: '100%' }}
                        animate={{ y: 0 }}
                        exit={{ y: '100%' }}
                        transition={{ type: 'spring', damping: 28, stiffness: 300 }}
                        boxShadow='0 -8px 30px rgba(0,0,0,0.5)'
                        zIndex={100}
                    >
                        <Flex justify='space-between' align='center' mb={3}>
                            <Box>
                                <Text color='white' fontWeight='bold' fontSize='md' fontFamily='monospace'>
                                    {cleanName(selectedNodeObj.name)}
                                    <Text as='span' color='gray.400' fontWeight='normal' ml={2}>
                                        {selectedNodeObj.namespace}
                                    </Text>
                                </Text>
                                <Flex gap={4} mt={1} fontSize='sm' color='gray.400' fontFamily='monospace'>
                                    <Text>{formatBytes(selectedNodeObj.totalBytes)} total traffic</Text>
                                    <Text>{selectedFlows.length} flows</Text>
                                </Flex>
                            </Box>
                            <Text
                                color='gray.500' fontSize='sm' cursor='pointer'
                                onClick={() => setSelectedNode(null)}
                                _hover={{ color: 'white' }} px={2}
                            >
                                ✕
                            </Text>
                        </Flex>

                        <Box overflowX='auto'>
                            <Table size='sm' variant='unstyled'>
                                <Thead>
                                    <Tr>
                                        <Th color='gray.500' fontSize='xs' px={2} py={1} fontFamily='monospace' textTransform='none'>Action</Th>
                                        <Th color='gray.500' fontSize='xs' px={2} py={1} fontFamily='monospace' textTransform='none'>Source</Th>
                                        <Th color='gray.500' fontSize='xs' px={2} py={1} fontFamily='monospace' textTransform='none'>Destination</Th>
                                        <Th color='gray.500' fontSize='xs' px={2} py={1} fontFamily='monospace' textTransform='none'>Proto</Th>
                                        <Th color='gray.500' fontSize='xs' px={2} py={1} fontFamily='monospace' textTransform='none'>Port</Th>
                                        <Th color='gray.500' fontSize='xs' px={2} py={1} fontFamily='monospace' textTransform='none'>Reporter</Th>
                                        <Th color='gray.500' fontSize='xs' px={2} py={1} fontFamily='monospace' textTransform='none' isNumeric>Bytes</Th>
                                        <Th color='gray.500' fontSize='xs' px={2} py={1} fontFamily='monospace' textTransform='none' isNumeric>Packets</Th>
                                    </Tr>
                                </Thead>
                                <Tbody>
                                    {selectedFlows.map((f) => {
                                        const bytes =
                                            (typeof f.bytes_in === 'number' ? f.bytes_in : parseInt(f.bytes_in || '0')) +
                                            (typeof f.bytes_out === 'number' ? f.bytes_out : parseInt(f.bytes_out || '0'));
                                        const packets =
                                            (typeof f.packets_in === 'number' ? f.packets_in as number : parseInt(f.packets_in || '0')) +
                                            (typeof f.packets_out === 'number' ? f.packets_out as number : parseInt(f.packets_out || '0'));
                                        const actionColor = ACTION_COLORS[f.action] || 'gray.400';
                                        return (
                                            <Tr key={f.id} _hover={{ bg: 'rgba(255,255,255,0.03)' }}>
                                                <Td px={2} py={1.5}>
                                                    <Flex align='center' gap={1.5}>
                                                        <Box w='8px' h='8px' borderRadius='full' bg={actionColor} />
                                                        <Text fontSize='xs' fontFamily='monospace' fontWeight='bold' color={actionColor}>
                                                            {f.action}
                                                        </Text>
                                                    </Flex>
                                                </Td>
                                                <Td px={2} py={1.5}>
                                                    <Text fontSize='xs' fontFamily='monospace' color='gray.200'>
                                                        {f.source_namespace}/{cleanName(f.source_name)}
                                                    </Text>
                                                </Td>
                                                <Td px={2} py={1.5}>
                                                    <Text fontSize='xs' fontFamily='monospace' color='gray.200'>
                                                        {f.dest_namespace}/{cleanName(f.dest_name)}
                                                    </Text>
                                                </Td>
                                                <Td px={2} py={1.5}>
                                                    <Text fontSize='xs' fontFamily='monospace' color='gray.400'>{f.protocol}</Text>
                                                </Td>
                                                <Td px={2} py={1.5}>
                                                    <Text fontSize='xs' fontFamily='monospace' color='gray.400'>{f.dest_port}</Text>
                                                </Td>
                                                <Td px={2} py={1.5}>
                                                    <Text fontSize='xs' fontFamily='monospace' color='gray.400'>{f.reporter}</Text>
                                                </Td>
                                                <Td px={2} py={1.5} isNumeric>
                                                    <Text fontSize='xs' fontFamily='monospace' color='gray.300'>
                                                        {formatBytes(bytes)}
                                                    </Text>
                                                </Td>
                                                <Td px={2} py={1.5} isNumeric>
                                                    <Text fontSize='xs' fontFamily='monospace' color='gray.300'>
                                                        {packets.toLocaleString()}
                                                    </Text>
                                                </Td>
                                            </Tr>
                                        );
                                    })}
                                </Tbody>
                            </Table>
                        </Box>
                    </MotionBox>
                )}
            </AnimatePresence>
        </Box>
    );
};

export default TopologyGraph;
