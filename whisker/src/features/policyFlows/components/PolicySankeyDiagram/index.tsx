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
    LinkFlowMap,
} from '../../utils/buildSankeyGraph';
import { FlowLog } from '@/types/render';
import { Box, Flex, Text, Table, Thead, Tbody, Tr, Th, Td } from '@chakra-ui/react';

type Props = {
    flows: FlowLog[];
    width?: number;
    height?: number;
    metric?: 'bytes' | 'packets';
    showPending?: boolean;
    reporterMode?: 'combined' | 'Src' | 'Dst';
    onFlowSelect?: (sourceName: string, sourceNamespace: string, destName: string, destNamespace: string) => void;
};

const ACTION_COLORS: Record<string, string> = {
    Allow: '#38A169',
    'Default Allow': '#68D391',
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
    reporterMode = 'combined',
    onFlowSelect,
}) => {
    const [hoveredNode, setHoveredNode] = React.useState<string | null>(null);
    const [selectedLink, setSelectedLink] = React.useState<number | null>(null);
    const [tooltipContent, setTooltipContent] = React.useState<string>('');
    const [tooltipPos, setTooltipPos] = React.useState({ x: 0, y: 0 });

    // Compute effective height based on node count so labels don't overlap.
    const effectiveHeight = React.useMemo(() => {
        const g = buildSankeyGraph(flows || [], metric, showPending, reporterMode);
        return Math.max(height, g.nodes.length * 35 + 40);
    }, [flows, metric, showPending, reporterMode, height]);

    const graph = React.useMemo(
        () => buildSankeyGraph(flows || [], metric, showPending, reporterMode),
        [flows, metric, showPending, reporterMode],
    );

    const sankeyData = React.useMemo(() => {
        if (!graph || graph.nodes.length === 0 || graph.links.length === 0)
            return null;

        const nodeIndexMap = new Map<string, number>();
        graph.nodes.forEach((n, i) => nodeIndexMap.set(n.id, i));

        const validLinks = graph.links.filter(
            (l) => nodeIndexMap.has(l.source) && nodeIndexMap.has(l.target),
        );

        if (validLinks.length === 0) return null;

        const sankeyLayout = d3Sankey<SankeyNode, SankeyLink>()
            .nodeId((d) => d.id)
            .nodeWidth(20)
            .nodePadding(28)
            .extent([
                [180, 30],
                [width - 250, effectiveHeight - 30],
            ]);

        try {
            const result = sankeyLayout({
                nodes: graph.nodes.map((n) => ({ ...n })),
                links: validLinks.map((l) => ({ ...l })),
            });

            // d3-sankey sizes nodes by throughput, causing low-volume
            // nodes to collapse to near-zero height with overlapping
            // labels. Fix: redistribute each column so every node gets
            // a uniform height with even spacing.
            const NODE_HEIGHT = 24;
            const NODE_GAP = 20;

            const columns = new Map<number, typeof result.nodes>();
            for (const node of result.nodes) {
                const col = Math.round(node.x0 ?? 0);
                if (!columns.has(col)) columns.set(col, []);
                columns.get(col)!.push(node);
            }

            for (const [, colNodes] of columns) {
                colNodes.sort(
                    (a, b) => (a.y0 ?? 0) - (b.y0 ?? 0),
                );
                const totalNeeded =
                    colNodes.length * NODE_HEIGHT +
                    (colNodes.length - 1) * NODE_GAP;
                const startY = Math.max(
                    30,
                    (effectiveHeight - totalNeeded) / 2,
                );

                colNodes.forEach((node, i) => {
                    node.y0 = startY + i * (NODE_HEIGHT + NODE_GAP);
                    node.y1 = node.y0 + NODE_HEIGHT;
                });
            }

            return result;
        } catch (e) {
            console.error('Sankey layout error:', e);
            return null;
        }
    }, [graph, width, effectiveHeight]);

    if (!sankeyData || sankeyData.nodes.length === 0) {
        return (
            <Flex
                align='center'
                justify='center'
                h={effectiveHeight}
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
            <svg width={width} height={effectiveHeight}>
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
                        const isSelected = selectedLink === i;
                        const opacity =
                            selectedLink !== null
                                ? isSelected
                                    ? 0.7
                                    : 0.15
                                : hoveredNode === null
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
                                    8,
                                    (link as any).width || 8,
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
                                onClick={() =>
                                    setSelectedLink(
                                        isSelected ? null : i,
                                    )
                                }
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
                        const isTier = n.type === 'tier';
                        const isAction = n.type === 'action';
                        const color = isAction
                            ? ACTION_COLORS[n.label] || NODE_COLORS.action
                            : NODE_COLORS[n.type] || '#A0AEC0';

                        return (
                            <g
                                key={n.id}
                                onMouseEnter={() => setHoveredNode(n.id)}
                                onMouseLeave={() => setHoveredNode(null)}
                                style={{ cursor: 'pointer' }}
                            >
                                {/* Tier nodes: wider bar with border */}
                                <rect
                                    x={
                                        isTier
                                            ? (n.x0 || 0) - 4
                                            : n.x0
                                    }
                                    y={n.y0}
                                    width={
                                        isTier
                                            ? nodeWidth + 8
                                            : nodeWidth
                                    }
                                    height={Math.max(nodeHeight, 2)}
                                    fill={color}
                                    stroke={
                                        isTier ? '#E2E8F0' : 'none'
                                    }
                                    strokeWidth={isTier ? 1.5 : 0}
                                    rx={isTier ? 4 : 3}
                                    opacity={
                                        hoveredNode === null ||
                                        hoveredNode === n.id
                                            ? 1
                                            : 0.4
                                    }
                                />
                                <text
                                    x={
                                        isTier
                                            ? (n.x0 || 0) - 8
                                            : (n.x1 || 0) + 6
                                    }
                                    y={(n.y0 || 0) + nodeHeight / 2}
                                    dy='0.35em'
                                    textAnchor={isTier ? 'end' : 'start'}
                                    fontSize={isTier ? 13 : 11}
                                    fontWeight={
                                        isTier || isAction
                                            ? 'bold'
                                            : 'normal'
                                    }
                                    fill={
                                        isTier
                                            ? '#FFF'
                                            : '#E2E8F0'
                                    }
                                    fontFamily='monospace'
                                >
                                    {isTier
                                        ? `▸ ${n.label}`
                                        : n.label}
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

            {/* Selected link detail panel */}
            {selectedLink !== null && sankeyData.links[selectedLink] && (
                <SelectedLinkDetail
                    link={sankeyData.links[selectedLink]}
                    linkIndex={selectedLink}
                    flows={flows}
                    linkFlowMap={graph.linkFlowMap}
                    metric={metric}
                    onClose={() => setSelectedLink(null)}
                    onFlowSelect={onFlowSelect}
                />
            )}
        </Box>
    );
};

const formatBytesShort = (b: number): string => {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
    return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

type DetailProps = {
    link: D3SankeyLink<SankeyNode, SankeyLink>;
    linkIndex: number;
    flows: FlowLog[];
    linkFlowMap: LinkFlowMap;
    metric: string;
    onClose: () => void;
    onFlowSelect?: (sourceName: string, sourceNamespace: string, destName: string, destNamespace: string) => void;
};

const SelectedLinkDetail: React.FC<DetailProps> = ({
    link,
    flows,
    linkFlowMap,
    metric,
    onClose,
    onFlowSelect,
}) => {
    const src = link.source as D3SankeyNode<SankeyNode, SankeyLink>;
    const tgt = link.target as D3SankeyNode<SankeyNode, SankeyLink>;

    // Find the link key to look up flow indices, then aggregate by
    // source/dest/protocol/port/action.
    const linkKey = `${src.id}|${tgt.id}`;
    const flowIndices = linkFlowMap.get(linkKey) || [];
    const uniqueIndices = [...new Set(flowIndices)];
    const matchedFlows = uniqueIndices
        .filter((i) => i < flows.length)
        .map((i) => flows[i]);

    type AggRow = {
        key: string;
        sourceNamespace: string;
        sourceName: string;
        destNamespace: string;
        destName: string;
        protocol: string;
        destPort: string;
        action: string;
        bytes: number;
        packets: number;
        count: number;
    };

    const aggMap = new Map<string, AggRow>();
    for (const f of matchedFlows) {
        const toNum = (v: string | number | undefined) =>
            typeof v === 'number' ? v : parseInt((v as string) || '0', 10) || 0;
        const k = `${f.source_namespace}/${f.source_name}|${f.dest_namespace}/${f.dest_name}|${f.protocol}|${f.dest_port}|${f.action}`;
        const existing = aggMap.get(k);
        const bytes = toNum(f.bytes_in) + toNum(f.bytes_out);
        const packets = toNum(f.packets_in) + toNum(f.packets_out);
        if (existing) {
            existing.bytes += bytes;
            existing.packets += packets;
            existing.count++;
        } else {
            aggMap.set(k, {
                key: k,
                sourceNamespace: f.source_namespace,
                sourceName: f.source_name,
                destNamespace: f.dest_namespace,
                destName: f.dest_name,
                protocol: f.protocol,
                destPort: String(f.dest_port),
                action: f.action,
                bytes,
                packets,
                count: 1,
            });
        }
    }
    const aggRows = Array.from(aggMap.values()).sort(
        (a, b) => b.bytes - a.bytes,
    );

    return (
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
                    <Text color='white' fontWeight='bold' fontSize='sm'>
                        {src.label} → {tgt.label}
                    </Text>
                    <Text color='gray.400' fontSize='xs'>
                        ({formatValue(link.value || 0, metric)})
                    </Text>
                </Flex>
                <Text
                    color='gray.400'
                    fontSize='xs'
                    cursor='pointer'
                    onClick={onClose}
                    _hover={{ color: 'white' }}
                >
                    ✕ close
                </Text>
            </Flex>

            {aggRows.length > 0 ? (
                <Box overflowX='auto' maxH='200px' overflowY='auto'>
                    <Table size='sm' variant='simple'>
                        <Thead>
                            <Tr>
                                <Th color='gray.400'>Source</Th>
                                <Th color='gray.400'>Destination</Th>
                                <Th color='gray.400'>Protocol</Th>
                                <Th color='gray.400'>Port</Th>
                                <Th color='gray.400'>Action</Th>
                                <Th color='gray.400' isNumeric>Bytes</Th>
                                <Th color='gray.400' isNumeric>Packets</Th>
                                <Th color='gray.400' isNumeric>Flows</Th>
                            </Tr>
                        </Thead>
                        <Tbody>
                            {aggRows.map((r) => (
                                <Tr
                                    key={r.key}
                                    cursor={onFlowSelect ? 'pointer' : undefined}
                                    _hover={onFlowSelect ? { bg: 'gray.700' } : undefined}
                                    onClick={() =>
                                        onFlowSelect?.(
                                            r.sourceName,
                                            r.sourceNamespace,
                                            r.destName,
                                            r.destNamespace,
                                        )
                                    }
                                >
                                    <Td color='gray.200' fontSize='xs'>
                                        {r.sourceNamespace}/{r.sourceName}
                                    </Td>
                                    <Td color='gray.200' fontSize='xs'>
                                        {r.destNamespace}/{r.destName}
                                    </Td>
                                    <Td color='gray.300' fontSize='xs'>
                                        {r.protocol}
                                    </Td>
                                    <Td color='gray.300' fontSize='xs'>
                                        {r.destPort}
                                    </Td>
                                    <Td fontSize='xs'>
                                        <Text
                                            color={ACTION_COLORS[r.action] || 'gray.300'}
                                            fontWeight='bold'
                                        >
                                            {r.action}
                                        </Text>
                                    </Td>
                                    <Td color='gray.300' fontSize='xs' isNumeric>
                                        {formatBytesShort(r.bytes)}
                                    </Td>
                                    <Td color='gray.300' fontSize='xs' isNumeric>
                                        {r.packets.toLocaleString()}
                                    </Td>
                                    <Td color='gray.300' fontSize='xs' isNumeric>
                                        {r.count}
                                    </Td>
                                </Tr>
                            ))}
                        </Tbody>
                    </Table>
                </Box>
            ) : (
                <Text color='gray.500' fontSize='xs'>
                    No individual flow records found for this link.
                </Text>
            )}
        </Box>
    );
};

export default PolicySankeyDiagram;
