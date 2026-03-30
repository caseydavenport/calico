import React from 'react';
import {
    sankey as d3Sankey,
    sankeyLinkHorizontal,
    SankeyNode as D3SankeyNode,
    SankeyLink as D3SankeyLink,
} from 'd3-sankey';
import {
    buildSankeyGraph,
    SankeyNode,
    SankeyLink,
} from '../../utils/buildSankeyGraph';
import { FlowLog } from '@/types/render';
import { Box, Flex, Text } from '@chakra-ui/react';

type Props = {
    flows: FlowLog[];
    width?: number;
    height?: number;
    metric?: 'bytes' | 'packets';
    showPending?: boolean;
};

const ACTION_COLORS: Record<string, string> = {
    Allow: '#38A169',
    Deny: '#E53E3E',
    Pass: '#3182CE',
    Log: '#D69E2E',
};

const NODE_COLORS: Record<string, string> = {
    tier: '#4A5568',
    policy: '#2B6CB0',
    action: '#718096',
};

type SNode = D3SankeyNode<SankeyNode, SankeyLink>;
type SLink = D3SankeyLink<SankeyNode, SankeyLink>;

const formatValue = (value: number, metric: string) => {
    if (metric === 'bytes') {
        if (value < 1024) return `${value} B`;
        if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
        if (value < 1024 * 1024 * 1024)
            return `${(value / (1024 * 1024)).toFixed(1)} MB`;
        return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    }
    return `${value.toLocaleString()} pkts`;
};

const getLinkColor = (link: SLink) => {
    const targetNode = link.target as SNode;
    if (targetNode.type === 'action') {
        return ACTION_COLORS[targetNode.label] || '#A0AEC0';
    }
    // For mid-chain links, use the eventual action color by tracing forward
    return '#A0AEC0';
};

const PolicySankeyDiagram: React.FC<Props> = ({
    flows,
    width = 900,
    height = 500,
    metric = 'bytes',
    showPending = false,
}) => {
    const [hoveredNode, setHoveredNode] = React.useState<string | null>(null);
    const [tooltipContent, setTooltipContent] = React.useState<string>('');
    const [tooltipPos, setTooltipPos] = React.useState({ x: 0, y: 0 });

    const graph = React.useMemo(
        () => buildSankeyGraph(flows, metric, showPending),
        [flows, metric, showPending],
    );

    const sankeyData = React.useMemo(() => {
        if (graph.nodes.length === 0 || graph.links.length === 0) return null;

        const nodeIndexMap = new Map<string, number>();
        graph.nodes.forEach((n, i) => nodeIndexMap.set(n.id, i));

        const validLinks = graph.links.filter(
            (l) => nodeIndexMap.has(l.source) && nodeIndexMap.has(l.target),
        );

        if (validLinks.length === 0) return null;

        const sankeyLayout = d3Sankey<SankeyNode, SankeyLink>()
            .nodeId((d) => d.id)
            .nodeWidth(20)
            .nodePadding(12)
            .extent([
                [40, 20],
                [width - 40, height - 20],
            ]);

        try {
            return sankeyLayout({
                nodes: graph.nodes.map((n) => ({ ...n })),
                links: validLinks.map((l) => ({ ...l })),
            });
        } catch {
            return null;
        }
    }, [graph, width, height]);

    if (!sankeyData || sankeyData.nodes.length === 0) {
        return (
            <Flex
                align='center'
                justify='center'
                h={height}
                color='gray.500'
            >
                <Text>
                    No policy trace data available. Flows need enforced
                    policies to render the Sankey diagram.
                </Text>
            </Flex>
        );
    }

    const linkPath = sankeyLinkHorizontal();

    const isLinkConnected = (link: SLink, nodeId: string) => {
        const src = link.source as SNode;
        const tgt = link.target as SNode;
        return src.id === nodeId || tgt.id === nodeId;
    };

    return (
        <Box position='relative'>
            <svg width={width} height={height}>
                <defs>
                    {sankeyData.links.map((link, i) => {
                        const src = link.source as SNode;
                        const tgt = link.target as SNode;
                        const color = getLinkColor(link);
                        return (
                            <linearGradient
                                key={i}
                                id={`link-gradient-${i}`}
                                x1={src.x1}
                                x2={tgt.x0}
                                gradientUnits='userSpaceOnUse'
                            >
                                <stop
                                    offset='0%'
                                    stopColor={
                                        NODE_COLORS[src.type] || '#A0AEC0'
                                    }
                                    stopOpacity={0.5}
                                />
                                <stop
                                    offset='100%'
                                    stopColor={color}
                                    stopOpacity={0.7}
                                />
                            </linearGradient>
                        );
                    })}
                </defs>

                {/* Links */}
                <g>
                    {sankeyData.links.map((link, i) => {
                        const opacity =
                            hoveredNode === null
                                ? 0.4
                                : isLinkConnected(link, hoveredNode)
                                  ? 0.7
                                  : 0.1;

                        return (
                            <path
                                key={i}
                                d={linkPath(link) || ''}
                                fill='none'
                                stroke={`url(#link-gradient-${i})`}
                                strokeWidth={Math.max(
                                    1,
                                    (link as any).width || 1,
                                )}
                                strokeOpacity={opacity}
                                onMouseEnter={(e) => {
                                    const src = link.source as SNode;
                                    const tgt = link.target as SNode;
                                    setTooltipContent(
                                        `${src.label} → ${tgt.label}: ${formatValue(link.value || 0, metric)}`,
                                    );
                                    setTooltipPos({
                                        x: e.clientX,
                                        y: e.clientY,
                                    });
                                }}
                                onMouseLeave={() => setTooltipContent('')}
                                style={{ cursor: 'pointer' }}
                            />
                        );
                    })}
                </g>

                {/* Nodes */}
                <g>
                    {sankeyData.nodes.map((node) => {
                        const n = node as SNode;
                        const nodeWidth = (n.x1 || 0) - (n.x0 || 0);
                        const nodeHeight = (n.y1 || 0) - (n.y0 || 0);
                        const color =
                            n.type === 'action'
                                ? ACTION_COLORS[n.label] || NODE_COLORS.action
                                : NODE_COLORS[n.type] || '#A0AEC0';

                        return (
                            <g
                                key={n.id}
                                onMouseEnter={() => setHoveredNode(n.id)}
                                onMouseLeave={() => setHoveredNode(null)}
                                style={{ cursor: 'pointer' }}
                            >
                                <rect
                                    x={n.x0}
                                    y={n.y0}
                                    width={nodeWidth}
                                    height={Math.max(nodeHeight, 2)}
                                    fill={color}
                                    rx={3}
                                    opacity={
                                        hoveredNode === null ||
                                        hoveredNode === n.id
                                            ? 1
                                            : 0.4
                                    }
                                />
                                <text
                                    x={
                                        n.type === 'action'
                                            ? (n.x1 || 0) + 6
                                            : n.type === 'tier'
                                              ? (n.x0 || 0) - 6
                                              : (n.x1 || 0) + 6
                                    }
                                    y={(n.y0 || 0) + nodeHeight / 2}
                                    dy='0.35em'
                                    textAnchor={
                                        n.type === 'tier' ? 'end' : 'start'
                                    }
                                    fontSize={11}
                                    fill='#E2E8F0'
                                    fontFamily='monospace'
                                >
                                    {n.label}
                                </text>
                            </g>
                        );
                    })}
                </g>

                {/* Column labels */}
                <text
                    x={40}
                    y={12}
                    fontSize={11}
                    fill='#A0AEC0'
                    fontWeight='bold'
                >
                    TIERS
                </text>
                <text
                    x={width / 2}
                    y={12}
                    fontSize={11}
                    fill='#A0AEC0'
                    fontWeight='bold'
                    textAnchor='middle'
                >
                    POLICIES
                </text>
                <text
                    x={width - 40}
                    y={12}
                    fontSize={11}
                    fill='#A0AEC0'
                    fontWeight='bold'
                    textAnchor='end'
                >
                    ACTION
                </text>
            </svg>

            {tooltipContent && (
                <Box
                    position='fixed'
                    left={tooltipPos.x + 12}
                    top={tooltipPos.y - 20}
                    bg='gray.800'
                    color='white'
                    px={3}
                    py={1}
                    borderRadius='md'
                    fontSize='xs'
                    fontFamily='monospace'
                    pointerEvents='none'
                    zIndex={1000}
                    whiteSpace='nowrap'
                >
                    {tooltipContent}
                </Box>
            )}
        </Box>
    );
};

export default PolicySankeyDiagram;
