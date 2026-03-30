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

type Props = {
    flows: FlowLog[];
    width?: number;
    height?: number;
    highlightSrc?: string; // "namespace/name" to auto-select
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
    '#2B6CB0',
    '#38A169',
    '#D69E2E',
    '#9F7AEA',
    '#ED64A6',
    '#DD6B20',
    '#319795',
    '#E53E3E',
];

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
    const [selectedEdge, setSelectedEdge] = React.useState<string | null>(null);
    const [tooltipContent, setTooltipContent] = React.useState<string>('');
    const [tooltipPos, setTooltipPos] = React.useState({ x: 0, y: 0 });
    const [transform, setTransform] = React.useState(d3.zoomIdentity);
    const simulationRef = React.useRef<d3.Simulation<SimNode, SimEdge>>();

    const graph = React.useMemo(
        () => buildTopologyGraph(flows || []),
        [flows],
    );

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

    // Find the underlying flows for the selected edge
    const selectedFlows = React.useMemo(() => {
        if (!selectedEdge || !flows) return [];
        const edge = edges.find((e) => e.id === selectedEdge);
        if (!edge) return [];
        const srcName = edge.source.name;
        const srcNs = edge.source.namespace;
        const dstName = edge.target.name;
        const dstNs = edge.target.namespace;
        return flows.filter((f) => {
            const srcMatch =
                f.source_name === srcName &&
                (f.source_namespace || '(external)') === srcNs;
            const dstMatch =
                f.dest_name === dstName &&
                (f.dest_namespace || '(external)') === dstNs;
            return srcMatch && dstMatch;
        });
    }, [selectedEdge, flows, edges]);

    React.useEffect(() => {
        if (graph.nodes.length === 0) return;

        const simNodes: SimNode[] = graph.nodes.map((n) => ({
            ...n,
            x: width / 2 + (Math.random() - 0.5) * 200,
            y: height / 2 + (Math.random() - 0.5) * 200,
        }));

        const nodeMap = new Map(simNodes.map((n) => [n.id, n]));
        const simEdges: SimEdge[] = graph.edges
            .map((e) => ({
                ...e,
                source: nodeMap.get(e.source)!,
                target: nodeMap.get(e.target)!,
            }))
            .filter((e) => e.source && e.target);

        const simulation = d3
            .forceSimulation<SimNode>(simNodes)
            .force(
                'link',
                d3
                    .forceLink<SimNode, SimEdge>(simEdges)
                    .id((d) => d.id)
                    .distance(100),
            )
            .force('charge', d3.forceManyBody().strength(-300))
            .force('center', d3.forceCenter(width / 2, height / 2))
            .force('collision', d3.forceCollide().radius(30))
            .alphaDecay(0.02);

        simulationRef.current = simulation;

        simulation.on('tick', () => {
            setNodes([...simNodes]);
            setEdges([...simEdges]);
        });

        return () => {
            simulation.stop();
        };
    }, [graph, width, height]);

    React.useEffect(() => {
        if (!svgRef.current) return;

        const zoom = d3
            .zoom<SVGSVGElement, unknown>()
            .scaleExtent([0.2, 4])
            .on('zoom', (event) => {
                setTransform(event.transform);
            });

        d3.select(svgRef.current).call(zoom);

        // D3 zoom captures mousedown, so we use a native click
        // listener on the SVG that checks if the target has an
        // edge data attribute.
        const svg = svgRef.current;
        const handleClick = (e: MouseEvent) => {
            const target = e.target as SVGElement;
            const edgeId = target.getAttribute('data-edge-id');
            if (edgeId) {
                setSelectedEdge(edgeId);
            } else if (target === svg || target.tagName === 'svg') {
                setSelectedEdge(null);
            }
        };
        svg.addEventListener('click', handleClick);
        return () => svg.removeEventListener('click', handleClick);
    }, []);

    // Auto-select edge matching the highlight query params
    const didAutoSelect = React.useRef(false);
    React.useEffect(() => {
        if (didAutoSelect.current || !highlightSrc || !highlightDst || edges.length === 0) return;
        const match = edges.find((e) => {
            const srcId = `${e.source.namespace === '(external)' ? '-' : e.source.namespace}/${e.source.name}`;
            const dstId = `${e.target.namespace === '(external)' ? '-' : e.target.namespace}/${e.target.name}`;
            return srcId === highlightSrc && dstId === highlightDst;
        });
        if (match) {
            setSelectedEdge(match.id);
            didAutoSelect.current = true;
        }
    }, [edges, highlightSrc, highlightDst]);

    const nodeRadius = (node: SimNode) => {
        const minR = 8;
        const maxR = 25;
        const maxNodeBytes = Math.max(
            ...nodes.map((n) => n.totalBytes),
            1,
        );
        return minR + (node.totalBytes / maxNodeBytes) * (maxR - minR);
    };

    const edgeWidth = (edge: SimEdge) => {
        return Math.max(1, (edge.bytes / maxBytes) * 8);
    };

    if (graph.nodes.length === 0) {
        return (
            <Flex align='center' justify='center' h={height} color='gray.500'>
                <Text>No flow data available for topology graph.</Text>
            </Flex>
        );
    }

    const isConnectedToHovered = (nodeId: string) => {
        if (!hoveredNode) return true;
        if (nodeId === hoveredNode) return true;
        return edges.some(
            (e) =>
                (e.source.id === hoveredNode && e.target.id === nodeId) ||
                (e.target.id === hoveredNode && e.source.id === nodeId),
        );
    };

    const isEdgeHighlighted = (edge: SimEdge) => {
        if (selectedEdge) return edge.id === selectedEdge;
        if (hoveredNode) {
            return (
                edge.source.id === hoveredNode ||
                edge.target.id === hoveredNode
            );
        }
        return true;
    };

    const isNodeHighlighted = (nodeId: string) => {
        if (selectedEdge) {
            const edge = edges.find((e) => e.id === selectedEdge);
            if (!edge) return false;
            return edge.source.id === nodeId || edge.target.id === nodeId;
        }
        return isConnectedToHovered(nodeId);
    };

    const selectedEdgeObj = edges.find((e) => e.id === selectedEdge);

    const graphHeight = selectedEdge ? height - 200 : height;

    return (
        <Box>
            <Box position='relative'>
                <svg
                    ref={svgRef}
                    width={width}
                    height={graphHeight}
                    style={{ background: '#1A202C', borderRadius: '8px' }}
                    onPointerDown={(e) => {
                        // Click on background clears selection
                        if (e.target === svgRef.current) {
                            setSelectedEdge(null);
                        }
                    }}
                >
                    <g
                        transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}
                    >
                        {/* Edges */}
                        <g>
                            {edges.map((edge) => {
                                const highlighted = isEdgeHighlighted(edge);
                                const isSelected = edge.id === selectedEdge;
                                const opacity = highlighted ? (isSelected ? 1 : 0.6) : 0.08;

                                return (
                                    <g key={edge.id}>
                                        <line
                                            x1={edge.source.x}
                                            y1={edge.source.y}
                                            x2={edge.target.x}
                                            y2={edge.target.y}
                                            stroke={
                                                isSelected
                                                    ? '#FFF'
                                                    : ACTION_COLORS[edge.action] || '#A0AEC0'
                                            }
                                            strokeWidth={Math.max(
                                                isSelected
                                                    ? edgeWidth(edge) + 2
                                                    : edgeWidth(edge),
                                                6,
                                            )}
                                            strokeOpacity={opacity}
                                            strokeDasharray={
                                                edge.action === 'Deny' ? '4,2' : undefined
                                            }
                                            style={{ cursor: 'pointer' }}
                                        />
                                        <circle
                                            cx={
                                                (edge.source.x! + edge.target.x!) / 2 +
                                                (edge.target.x! - edge.source.x!) * 0.15
                                            }
                                            cy={
                                                (edge.source.y! + edge.target.y!) / 2 +
                                                (edge.target.y! - edge.source.y!) * 0.15
                                            }
                                            r={isSelected ? 3 : 2}
                                            fill={
                                                isSelected
                                                    ? '#FFF'
                                                    : ACTION_COLORS[edge.action] || '#A0AEC0'
                                            }
                                            opacity={opacity}
                                            pointerEvents='none'
                                        />
                                    </g>
                                );
                            })}
                        </g>

                        {/* Nodes */}
                        <g>
                            {nodes.map((node) => {
                                const r = nodeRadius(node);
                                const color = nsColors.get(node.namespace) || '#718096';
                                const highlighted = isNodeHighlighted(node.id);

                                return (
                                    <g
                                        key={node.id}
                                        transform={`translate(${node.x},${node.y})`}
                                        opacity={highlighted ? 1 : 0.15}
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
                                        style={{ cursor: 'grab' }}
                                    >
                                        <circle
                                            r={r}
                                            fill={color}
                                            stroke={
                                                hoveredNode === node.id || isNodeHighlighted(node.id) && selectedEdge
                                                    ? '#fff'
                                                    : 'rgba(255,255,255,0.2)'
                                            }
                                            strokeWidth={
                                                hoveredNode === node.id ? 2 : 1
                                            }
                                        />
                                        <text
                                            dy={r + 12}
                                            textAnchor='middle'
                                            fontSize={10}
                                            fill='#E2E8F0'
                                            fontFamily='monospace'
                                        >
                                            {node.name.length > 20
                                                ? node.name.slice(0, 18) + '...'
                                                : node.name}
                                        </text>
                                        <text
                                            dy={r + 22}
                                            textAnchor='middle'
                                            fontSize={8}
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

                {tooltipContent && (
                    <Box
                        position='fixed'
                        left={tooltipPos.x + 12}
                        top={tooltipPos.y - 20}
                        bg='gray.800'
                        color='white'
                        px={3}
                        py={2}
                        borderRadius='md'
                        fontSize='xs'
                        fontFamily='monospace'
                        pointerEvents='none'
                        zIndex={1000}
                        whiteSpace='pre-line'
                    >
                        {tooltipContent}
                    </Box>
                )}

                {/* Legend */}
                <Flex
                    position='absolute'
                    bottom={4}
                    left={4}
                    bg='rgba(26, 32, 44, 0.9)'
                    borderRadius='md'
                    px={3}
                    py={2}
                    gap={4}
                    fontSize='xs'
                    color='gray.300'
                >
                    {Object.entries(ACTION_COLORS).map(([action, color]) => (
                        <Flex key={action} align='center' gap={1}>
                            <Box w={3} h={3} borderRadius='sm' bg={color} />
                            <Text>{action}</Text>
                        </Flex>
                    ))}
                </Flex>
            </Box>

            {/* Selected edge detail panel */}
            {selectedEdgeObj && (
                <Box
                    bg='gray.800'
                    borderRadius='lg'
                    border='1px solid'
                    borderColor='gray.600'
                    mt={3}
                    p={4}
                >
                    <Flex justify='space-between' align='center' mb={3}>
                        <Flex align='center' gap={2}>
                            <Box
                                w={3}
                                h={3}
                                borderRadius='sm'
                                bg={ACTION_COLORS[selectedEdgeObj.action] || '#A0AEC0'}
                            />
                            <Text color='white' fontWeight='bold' fontSize='sm'>
                                {selectedEdgeObj.source.name}
                                <Text as='span' color='gray.400' fontWeight='normal'>
                                    {' '}({selectedEdgeObj.source.namespace})
                                </Text>
                                {' → '}
                                {selectedEdgeObj.target.name}
                                <Text as='span' color='gray.400' fontWeight='normal'>
                                    {' '}({selectedEdgeObj.target.namespace})
                                </Text>
                            </Text>
                        </Flex>
                        <Text
                            color='gray.400'
                            fontSize='xs'
                            cursor='pointer'
                            onClick={() => setSelectedEdge(null)}
                            _hover={{ color: 'white' }}
                        >
                            ✕ close
                        </Text>
                    </Flex>

                    <Flex gap={6} mb={3} fontSize='xs' color='gray.300'>
                        <Text>
                            <Text as='span' fontWeight='bold' color='white'>
                                {formatBytes(selectedEdgeObj.bytes)}
                            </Text>{' '}
                            total
                        </Text>
                        <Text>
                            <Text as='span' fontWeight='bold' color='white'>
                                {selectedEdgeObj.packets.toLocaleString()}
                            </Text>{' '}
                            packets
                        </Text>
                        <Text>
                            Action:{' '}
                            <Text
                                as='span'
                                fontWeight='bold'
                                color={ACTION_COLORS[selectedEdgeObj.action] || 'white'}
                            >
                                {selectedEdgeObj.action}
                            </Text>
                        </Text>
                    </Flex>

                    {selectedFlows.length > 0 ? (
                        <Box overflowX='auto' maxH='150px' overflowY='auto'>
                            <Table size='sm' variant='simple'>
                                <Thead>
                                    <Tr>
                                        <Th color='gray.400'>Source</Th>
                                        <Th color='gray.400'>Destination</Th>
                                        <Th color='gray.400'>Protocol</Th>
                                        <Th color='gray.400'>Port</Th>
                                        <Th color='gray.400'>Action</Th>
                                        <Th color='gray.400'>Reporter</Th>
                                        <Th color='gray.400' isNumeric>Bytes In</Th>
                                        <Th color='gray.400' isNumeric>Bytes Out</Th>
                                        <Th color='gray.400' isNumeric>Packets In</Th>
                                        <Th color='gray.400' isNumeric>Packets Out</Th>
                                    </Tr>
                                </Thead>
                                <Tbody>
                                    {selectedFlows.map((f) => (
                                        <Tr key={f.id}>
                                            <Td color='gray.200' fontSize='xs'>
                                                {f.source_namespace}/{f.source_name}
                                            </Td>
                                            <Td color='gray.200' fontSize='xs'>
                                                {f.dest_namespace}/{f.dest_name}
                                            </Td>
                                            <Td color='gray.300' fontSize='xs'>
                                                {f.protocol}
                                            </Td>
                                            <Td color='gray.300' fontSize='xs'>
                                                {f.dest_port}
                                            </Td>
                                            <Td fontSize='xs'>
                                                <Text
                                                    color={ACTION_COLORS[f.action] || 'gray.300'}
                                                    fontWeight='bold'
                                                >
                                                    {f.action}
                                                </Text>
                                            </Td>
                                            <Td color='gray.300' fontSize='xs'>
                                                {f.reporter}
                                            </Td>
                                            <Td color='gray.300' fontSize='xs' isNumeric>
                                                {formatBytes(
                                                    typeof f.bytes_in === 'number'
                                                        ? f.bytes_in
                                                        : parseInt(f.bytes_in || '0'),
                                                )}
                                            </Td>
                                            <Td color='gray.300' fontSize='xs' isNumeric>
                                                {formatBytes(
                                                    typeof f.bytes_out === 'number'
                                                        ? f.bytes_out
                                                        : parseInt(f.bytes_out || '0'),
                                                )}
                                            </Td>
                                            <Td color='gray.300' fontSize='xs' isNumeric>
                                                {f.packets_in}
                                            </Td>
                                            <Td color='gray.300' fontSize='xs' isNumeric>
                                                {f.packets_out}
                                            </Td>
                                        </Tr>
                                    ))}
                                </Tbody>
                            </Table>
                        </Box>
                    ) : (
                        <Text color='gray.500' fontSize='xs'>
                            No individual flow records found for this edge.
                        </Text>
                    )}
                </Box>
            )}
        </Box>
    );
};

export default TopologyGraph;
