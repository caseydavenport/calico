import React from 'react';
import * as d3 from 'd3';
import {
    buildTopologyGraph,
    formatBytes,
    TopologyNode,
    TopologyEdge,
} from '../../utils/buildTopologyGraph';
import { FlowLog } from '@/types/render';
import { Box, Text, Flex } from '@chakra-ui/react';

type Props = {
    flows: FlowLog[];
    width?: number;
    height?: number;
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
}) => {
    const svgRef = React.useRef<SVGSVGElement>(null);
    const [nodes, setNodes] = React.useState<SimNode[]>([]);
    const [edges, setEdges] = React.useState<SimEdge[]>([]);
    const [hoveredNode, setHoveredNode] = React.useState<string | null>(null);
    const [tooltipContent, setTooltipContent] = React.useState<string>('');
    const [tooltipPos, setTooltipPos] = React.useState({ x: 0, y: 0 });
    const [transform, setTransform] = React.useState(
        d3.zoomIdentity,
    );
    const simulationRef = React.useRef<d3.Simulation<SimNode, SimEdge>>();

    const graph = React.useMemo(() => buildTopologyGraph(flows), [flows]);

    // Namespace color map
    const nsColors = React.useMemo(() => {
        const namespaces = [...new Set(graph.nodes.map((n) => n.namespace))];
        const colorMap = new Map<string, string>();
        namespaces.forEach((ns, i) => {
            colorMap.set(ns, NAMESPACE_COLORS[i % NAMESPACE_COLORS.length]);
        });
        return colorMap;
    }, [graph]);

    // Max bytes for edge scaling
    const maxBytes = React.useMemo(
        () => Math.max(...graph.edges.map((e) => e.bytes), 1),
        [graph],
    );

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

    // Zoom behavior
    React.useEffect(() => {
        if (!svgRef.current) return;

        const zoom = d3
            .zoom<SVGSVGElement, unknown>()
            .scaleExtent([0.2, 4])
            .on('zoom', (event) => {
                setTransform(event.transform);
            });

        d3.select(svgRef.current).call(zoom);
    }, []);

    // TODO: wire up pointer-event drag to pin/unpin nodes
    // For now, nodes can be repositioned by the force simulation only.

    const nodeRadius = (node: SimNode) => {
        const minR = 8;
        const maxR = 25;
        const maxNodeBytes = Math.max(
            ...nodes.map((n) => n.totalBytes),
            1,
        );
        return (
            minR + ((node.totalBytes / maxNodeBytes) * (maxR - minR))
        );
    };

    const edgeWidth = (edge: SimEdge) => {
        return Math.max(1, (edge.bytes / maxBytes) * 8);
    };

    if (graph.nodes.length === 0) {
        return (
            <Flex
                align='center'
                justify='center'
                h={height}
                color='gray.500'
            >
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

    return (
        <Box position='relative'>
            <svg
                ref={svgRef}
                width={width}
                height={height}
                style={{ background: '#1A202C', borderRadius: '8px' }}
            >
                <g
                    transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}
                >
                    {/* Edges */}
                    <g>
                        {edges.map((edge) => {
                            const opacity =
                                hoveredNode === null
                                    ? 0.6
                                    : edge.source.id === hoveredNode ||
                                        edge.target.id === hoveredNode
                                      ? 0.9
                                      : 0.1;

                            return (
                                <g key={edge.id}>
                                    <line
                                        x1={edge.source.x}
                                        y1={edge.source.y}
                                        x2={edge.target.x}
                                        y2={edge.target.y}
                                        stroke={
                                            ACTION_COLORS[edge.action] ||
                                            '#A0AEC0'
                                        }
                                        strokeWidth={edgeWidth(edge)}
                                        strokeOpacity={opacity}
                                        strokeDasharray={
                                            edge.action === 'Deny'
                                                ? '4,2'
                                                : undefined
                                        }
                                        onMouseEnter={(e) => {
                                            setTooltipContent(
                                                `${edge.source.name} → ${edge.target.name}\n${formatBytes(edge.bytes)} | ${edge.action} | ${edge.protocol}:${edge.destPort}`,
                                            );
                                            setTooltipPos({
                                                x: e.clientX,
                                                y: e.clientY,
                                            });
                                        }}
                                        onMouseLeave={() =>
                                            setTooltipContent('')
                                        }
                                        style={{ cursor: 'pointer' }}
                                    />
                                    {/* Arrowhead */}
                                    <circle
                                        cx={
                                            (edge.source.x! + edge.target.x!) /
                                                2 +
                                            (edge.target.x! - edge.source.x!) *
                                                0.15
                                        }
                                        cy={
                                            (edge.source.y! + edge.target.y!) /
                                                2 +
                                            (edge.target.y! - edge.source.y!) *
                                                0.15
                                        }
                                        r={2}
                                        fill={
                                            ACTION_COLORS[edge.action] ||
                                            '#A0AEC0'
                                        }
                                        opacity={opacity}
                                    />
                                </g>
                            );
                        })}
                    </g>

                    {/* Nodes */}
                    <g>
                        {nodes.map((node) => {
                            const r = nodeRadius(node);
                            const color =
                                nsColors.get(node.namespace) || '#718096';
                            const connected = isConnectedToHovered(node.id);

                            return (
                                <g
                                    key={node.id}
                                    transform={`translate(${node.x},${node.y})`}
                                    opacity={connected ? 1 : 0.2}
                                    onMouseEnter={(e) => {
                                        setHoveredNode(node.id);
                                        setTooltipContent(
                                            `${node.name}\n${node.namespace}\n${formatBytes(node.totalBytes)}`,
                                        );
                                        setTooltipPos({
                                            x: e.clientX,
                                            y: e.clientY,
                                        });
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
                                            hoveredNode === node.id
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
    );
};

export default TopologyGraph;
