import React from 'react';
import {
    buildDualSankey,
    DualSankeyNode,
    LogicalFlow,
} from '../../utils/buildDualSankey';
import { FlowLog } from '@/types/render';
import { Box, Flex, Text, Table, Tbody, Tr, Td } from '@chakra-ui/react';

type Props = {
    flows: FlowLog[];
    width?: number;
    height?: number;
    metric?: 'bytes' | 'packets';
    showPending?: boolean;
    onFlowSelect?: (
        sourceName: string,
        sourceNamespace: string,
        destName: string,
        destNamespace: string,
    ) => void;
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
    flow: '#805AD5',
};

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

// ── Manual layout engine ────────────────────────────────────────────
// Instead of d3-sankey, we position everything ourselves.
//
// Structure for each side (egress/ingress):
//   Column 0: Tier nodes
//   Column 1+: Policy nodes within each tier
//
// The center column has logical flow nodes.
// Each logical flow gets a horizontal "lane" (Y band).
// Tiers and policies are positioned within the lanes of
// the flows that traverse them.

type PositionedNode = {
    node: DualSankeyNode;
    x: number;
    y: number;
    w: number;
    h: number;
};

type PositionedLink = {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    value: number;
    flowId: string;
};

type ManualLayout = {
    flowNodes: PositionedNode[];
    egressNodes: PositionedNode[];
    ingressNodes: PositionedNode[];
    egressLinks: PositionedLink[];
    ingressLinks: PositionedLink[];
    totalHeight: number;
};

const NODE_H = 22;
const LANE_GAP = 8;
const COL_WIDTH = 16;
const TIER_WIDTH = 20;

// Collect unique tier names in evaluation order for a side.
const getOrderedTiers = (flows: LogicalFlow[], side: 'egress' | 'ingress'): string[] => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const lf of flows) {
        const policies = side === 'egress' ? lf.egressPolicies : lf.ingressPolicies;
        for (const p of policies) {
            const tier = p.tier || '_profile_';
            if (tier === '_profile_') continue;
            if (!seen.has(tier)) {
                seen.add(tier);
                result.push(tier);
            }
        }
    }
    return result;
};

// Layout columns left-to-right:
//  [Source] [Egress Tier|Policy...] [Egress Action] || [Ingress Tier|Policy...] [Ingress Action] [Dest]
const buildManualLayout = (
    flows: LogicalFlow[],
    width: number,
): ManualLayout => {
    const centerX = width / 2;
    const laneHeight = NODE_H + LANE_GAP;
    const topMargin = 35;

    const flowNodes: PositionedNode[] = [];
    const egressNodes: PositionedNode[] = [];
    const ingressNodes: PositionedNode[] = [];
    const egressLinks: PositionedLink[] = [];
    const ingressLinks: PositionedLink[] = [];

    const egressTiers = getOrderedTiers(flows, 'egress');
    const ingressTiers = getOrderedTiers(flows, 'ingress');

    // Define fixed X regions.
    // Left half:  [srcLabel] [eTier0][ePol0] [eTier1][ePol1] ... [eAction]  ||
    // Right half: || [iTier0][iPol0] [iTier1][iPol1] ... [iAction] [dstLabel]
    const srcLabelX = 10;
    const egressStart = 160;
    const egressActionX = centerX - 50;
    const ingressStart = centerX + 20;
    const ingressActionX = width - 180;
    const dstLabelX = width - 10;

    // Space egress tier+policy columns evenly between egressStart and egressActionX
    const eColCount = egressTiers.length;
    const eSlotWidth = eColCount > 0 ? (egressActionX - egressStart - 30) / eColCount : 0;
    const egressTierX = new Map<string, { tierX: number; policyX: number }>();
    egressTiers.forEach((tier, i) => {
        egressTierX.set(tier, {
            tierX: egressStart + i * eSlotWidth,
            policyX: egressStart + i * eSlotWidth + TIER_WIDTH + 4,
        });
    });

    // Space ingress tier+policy columns between ingressStart and ingressActionX
    const iColCount = ingressTiers.length;
    const iSlotWidth = iColCount > 0 ? (ingressActionX - ingressStart - 30) / iColCount : 0;
    const ingressTierX = new Map<string, { tierX: number; policyX: number }>();
    ingressTiers.forEach((tier, i) => {
        ingressTierX.set(tier, {
            tierX: ingressStart + i * iSlotWidth,
            policyX: ingressStart + i * iSlotWidth + TIER_WIDTH + 4,
        });
    });

    const egressTierYs = new Map<string, { minY: number; maxY: number }>();
    const ingressTierYs = new Map<string, { minY: number; maxY: number }>();

    // Determine egress/ingress action label per flow
    const getTerminalAction = (policies: ReturnType<typeof Object.values<LogicalFlow>>[number]['egressPolicies'], flowAction: string): string => {
        if (policies.length === 0) return flowAction;
        const last = policies[policies.length - 1];
        if (last.trigger) return last.action; // end-of-tier
        if (last.kind === 'Profile' && last.name.startsWith('kns.')) return 'Default Allow';
        return last.action;
    };

    flows.forEach((lf, i) => {
        const y = topMargin + i * laneHeight;
        const cy = y + NODE_H / 2;

        // Source label (far left)
        flowNodes.push({
            node: {
                id: `src:${lf.id}`,
                label: lf.sourceName.replace(/-[a-z0-9]{8,}-\*$/, '-*'),
                type: 'flow',
                side: 'egress',
            },
            x: srcLabelX,
            y,
            w: 0, // text-only, no rect
            h: NODE_H,
        });

        // Dest label (far right)
        flowNodes.push({
            node: {
                id: `dst:${lf.id}`,
                label: lf.destName.replace(/-[a-z0-9]{8,}-\*$/, '-*'),
                type: 'flow',
                side: 'ingress',
            },
            x: dstLabelX,
            y,
            w: 0,
            h: NODE_H,
        });

        // Egress action node
        const eAction = getTerminalAction(lf.egressPolicies, lf.action);
        egressNodes.push({
            node: {
                id: `eaction:${lf.id}`,
                label: eAction,
                type: 'policy',
                side: 'egress',
            },
            x: egressActionX,
            y,
            w: COL_WIDTH,
            h: NODE_H,
        });

        // Ingress action node
        const iAction = getTerminalAction(lf.ingressPolicies, lf.action);
        ingressNodes.push({
            node: {
                id: `iaction:${lf.id}`,
                label: iAction,
                type: 'policy',
                side: 'ingress',
            },
            x: ingressActionX,
            y,
            w: COL_WIDTH,
            h: NODE_H,
        });

        // Egress policies (left-to-right: tier order matches evaluation order)
        const ePols = [...lf.egressPolicies].sort(
            (a, b) => (a.policy_index ?? 0) - (b.policy_index ?? 0),
        );
        let ePrevRightX = egressStart - 10;
        for (const p of ePols) {
            const tier = p.tier || '_profile_';
            if (tier === '_profile_' || (p.kind === 'Profile' && p.name.startsWith('kns.'))) continue;
            if (p.trigger) continue;
            const coords = egressTierX.get(tier);
            if (!coords) continue;

            const ext = egressTierYs.get(tier) || { minY: y, maxY: y + NODE_H };
            ext.minY = Math.min(ext.minY, y);
            ext.maxY = Math.max(ext.maxY, y + NODE_H);
            egressTierYs.set(tier, ext);

            egressNodes.push({
                node: {
                    id: `e:${tier}/${p.name}:${i}`,
                    label: `${p.name} (${p.action})`,
                    type: 'policy',
                    side: 'egress',
                    tier,
                    kind: p.kind,
                },
                x: coords.policyX,
                y,
                w: COL_WIDTH,
                h: NODE_H,
            });

            egressLinks.push({
                x1: ePrevRightX,
                y1: cy,
                x2: coords.policyX,
                y2: cy,
                value: lf.volume,
                flowId: lf.id,
            });
            ePrevRightX = coords.policyX + COL_WIDTH;
        }
        // Link last egress policy → egress action
        egressLinks.push({
            x1: ePrevRightX,
            y1: cy,
            x2: egressActionX,
            y2: cy,
            value: lf.volume,
            flowId: lf.id,
        });

        // Divider link: egress action → ingress start
        egressLinks.push({
            x1: egressActionX + COL_WIDTH,
            y1: cy,
            x2: ingressStart - 10,
            y2: cy,
            value: lf.volume,
            flowId: lf.id,
        });

        // Ingress policies
        const iPols = [...lf.ingressPolicies].sort(
            (a, b) => (a.policy_index ?? 0) - (b.policy_index ?? 0),
        );
        let iPrevRightX = ingressStart - 10;
        for (const p of iPols) {
            const tier = p.tier || '_profile_';
            if (tier === '_profile_' || (p.kind === 'Profile' && p.name.startsWith('kns.'))) continue;
            if (p.trigger) continue;
            const coords = ingressTierX.get(tier);
            if (!coords) continue;

            const ext = ingressTierYs.get(tier) || { minY: y, maxY: y + NODE_H };
            ext.minY = Math.min(ext.minY, y);
            ext.maxY = Math.max(ext.maxY, y + NODE_H);
            ingressTierYs.set(tier, ext);

            ingressNodes.push({
                node: {
                    id: `i:${tier}/${p.name}:${i}`,
                    label: `${p.name} (${p.action})`,
                    type: 'policy',
                    side: 'ingress',
                    tier,
                    kind: p.kind,
                },
                x: coords.policyX,
                y,
                w: COL_WIDTH,
                h: NODE_H,
            });

            ingressLinks.push({
                x1: iPrevRightX,
                y1: cy,
                x2: coords.policyX,
                y2: cy,
                value: lf.volume,
                flowId: lf.id,
            });
            iPrevRightX = coords.policyX + COL_WIDTH;
        }
        // Link last ingress policy → ingress action
        ingressLinks.push({
            x1: iPrevRightX,
            y1: cy,
            x2: ingressActionX,
            y2: cy,
            value: lf.volume,
            flowId: lf.id,
        });
    });

    // Place tier bars spanning their flow lanes
    for (const tier of egressTiers) {
        const coords = egressTierX.get(tier);
        const ext = egressTierYs.get(tier);
        if (!coords || !ext) continue;
        egressNodes.push({
            node: { id: `etier:${tier}`, label: tier, type: 'tier', side: 'egress', tier },
            x: coords.tierX,
            y: ext.minY - 4,
            w: TIER_WIDTH,
            h: ext.maxY - ext.minY + 8,
        });
    }
    for (const tier of ingressTiers) {
        const coords = ingressTierX.get(tier);
        const ext = ingressTierYs.get(tier);
        if (!coords || !ext) continue;
        ingressNodes.push({
            node: { id: `itier:${tier}`, label: tier, type: 'tier', side: 'ingress', tier },
            x: coords.tierX,
            y: ext.minY - 4,
            w: TIER_WIDTH,
            h: ext.maxY - ext.minY + 8,
        });
    }

    const totalHeight = topMargin + flows.length * laneHeight + 20;

    return { flowNodes, egressNodes, ingressNodes, egressLinks, ingressLinks, totalHeight };
};

// ── Component ───────────────────────────────────────────────────────

const DualSankeyDiagram: React.FC<Props> = ({
    flows,
    width = 1200,
    height = 600,
    metric = 'bytes',
    showPending = false,
    onFlowSelect,
}) => {
    const [selectedFlow, setSelectedFlow] = React.useState<string | null>(null);
    const [tooltipContent, setTooltipContent] = React.useState<string>('');
    const [tooltipPos, setTooltipPos] = React.useState({ x: 0, y: 0 });

    const dual = React.useMemo(
        () => buildDualSankey(flows || [], metric, showPending),
        [flows, metric, showPending],
    );

    const layout = React.useMemo(
        () => buildManualLayout(dual.logicalFlows, width),
        [dual, width],
    );

    const effectiveHeight = Math.max(height, layout.totalHeight);

    const selectedLogicalFlow = dual.logicalFlows.find(
        (lf) => lf.id === selectedFlow,
    );

    if (dual.logicalFlows.length === 0) {
        return (
            <Flex align='center' justify='center' h={height} color='gray.500'>
                <Text>No policy trace data available.</Text>
            </Flex>
        );
    }

    // Build a map from flow ID to action color for link coloring
    const flowActionColor = React.useMemo(() => {
        const map = new Map<string, string>();
        for (const lf of dual.logicalFlows) {
            map.set(lf.id, ACTION_COLORS[lf.action] || '#718096');
        }
        return map;
    }, [dual]);

    // Compute max volume for link width scaling
    const maxVolume = React.useMemo(
        () => Math.max(...dual.logicalFlows.map((lf) => lf.volume), 1),
        [dual],
    );

    const renderNode = (pn: PositionedNode) => {
        const { node, x, y, w, h } = pn;
        const isTier = node.type === 'tier';
        const isFlow = node.type === 'flow';
        const isSrcDst = isFlow && (node.id.startsWith('src:') || node.id.startsWith('dst:'));
        const isAction = node.id.startsWith('eaction:') || node.id.startsWith('iaction:');

        // Find the parent flow for selection highlighting
        const parentFlowId = node.id.replace(/^(src:|dst:|eaction:|iaction:)/, 'flow:');
        const isRelatedToSelected =
            selectedFlow === null ||
            parentFlowId === selectedFlow ||
            isTier;
        const dimmed = !isRelatedToSelected;

        // Action nodes get action color
        const color = isAction
            ? ACTION_COLORS[node.label] || '#718096'
            : NODE_COLORS[node.type] || '#A0AEC0';

        // Source/dest: text only, no rect
        if (isSrcDst) {
            const isSrc = node.id.startsWith('src:');
            return (
                <g
                    key={node.id}
                    onClick={() => {
                        const fid = node.id.replace(/^(src:|dst:)/, 'flow:');
                        setSelectedFlow(selectedFlow === fid ? null : fid);
                    }}
                    style={{ cursor: 'pointer' }}
                >
                    <text
                        x={x}
                        y={y + h / 2}
                        dy='0.35em'
                        textAnchor={isSrc ? 'start' : 'end'}
                        fontSize={10}
                        fill={dimmed ? '#4A5568' : '#E2E8F0'}
                        fontFamily='monospace'
                        fontWeight='bold'
                    >
                        {node.label}
                    </text>
                </g>
            );
        }

        return (
            <g
                key={node.id}
                onMouseEnter={(e) => {
                    setTooltipContent(node.label);
                    setTooltipPos({ x: e.clientX, y: e.clientY });
                }}
                onMouseLeave={() => setTooltipContent('')}
            >
                <rect
                    x={x}
                    y={y}
                    width={isTier ? w : w}
                    height={h}
                    fill={color}
                    stroke={isTier ? '#E2E8F0' : 'none'}
                    strokeWidth={isTier ? 1 : 0}
                    rx={isTier ? 4 : 3}
                    opacity={dimmed ? 0.15 : 1}
                />
                {isTier && (
                    <text
                        x={node.side === 'egress' ? x - 6 : x + w + 6}
                        y={y + h / 2}
                        dy='0.35em'
                        textAnchor={node.side === 'egress' ? 'end' : 'start'}
                        fontSize={11}
                        fontWeight='bold'
                        fill='#FFF'
                        fontFamily='monospace'
                        opacity={dimmed ? 0.15 : 1}
                    >
                        {node.label}
                    </text>
                )}
                {!isTier && (
                    <text
                        x={node.side === 'egress' ? x + w + 4 : x - 4}
                        y={y + h / 2}
                        dy='0.35em'
                        textAnchor={node.side === 'egress' ? 'start' : 'end'}
                        fontSize={isAction ? 10 : 9}
                        fontWeight={isAction ? 'bold' : 'normal'}
                        fill={isAction ? (ACTION_COLORS[node.label] || '#CBD5E0') : '#CBD5E0'}
                        fontFamily='monospace'
                        opacity={dimmed ? 0.15 : 1}
                    >
                        {node.label}
                    </text>
                )}
            </g>
        );
    };

    const renderLink = (link: PositionedLink, i: number, prefix: string) => {
        const dimmed = selectedFlow !== null && link.flowId !== selectedFlow;
        const color = flowActionColor.get(link.flowId) || '#4A5568';
        // Scale width: min 2, max 8, proportional to volume
        const w = 2 + (link.value / maxVolume) * 6;
        return (
            <line
                key={`${prefix}-${i}`}
                x1={link.x1}
                y1={link.y1}
                x2={link.x2}
                y2={link.y2}
                stroke={color}
                strokeWidth={w}
                strokeOpacity={dimmed ? 0.05 : 0.5}
                strokeLinecap='round'
            />
        );
    };

    return (
        <Box>
            <Box position='relative' overflowY='auto' maxH='calc(100vh - 250px)'>
                <svg width={width} height={effectiveHeight}>
                    {/* Headers */}
                    <text x={10} y={16} fontSize={11} fill='#A0AEC0' fontWeight='bold'>
                        SOURCE
                    </text>
                    <text x={160} y={16} fontSize={11} fill='#A0AEC0' fontWeight='bold'>
                        EGRESS POLICIES
                    </text>
                    <text x={width / 2 - 50} y={16} fontSize={11} fill='#718096' fontWeight='bold'>
                        ACTION
                    </text>
                    <text x={width / 2 + 20} y={16} fontSize={11} fill='#A0AEC0' fontWeight='bold'>
                        INGRESS POLICIES
                    </text>
                    <text x={width - 180} y={16} fontSize={11} fill='#718096' fontWeight='bold'>
                        ACTION
                    </text>
                    <text x={width - 10} y={16} fontSize={11} fill='#A0AEC0' fontWeight='bold' textAnchor='end'>
                        DEST
                    </text>

                    {/* Center divider */}
                    <line x1={width / 2 - 15} y1={25} x2={width / 2 - 15} y2={effectiveHeight - 5} stroke='#2D3748' strokeWidth={1} strokeDasharray='4,4' />

                    {/* Links (behind nodes) */}
                    {layout.egressLinks.map((l, i) => renderLink(l, i, 'e'))}
                    {layout.ingressLinks.map((l, i) => renderLink(l, i, 'i'))}

                    {/* Nodes */}
                    {layout.egressNodes.map(renderNode)}
                    {layout.flowNodes.map(renderNode)}
                    {layout.ingressNodes.map(renderNode)}
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

            {/* Selected flow detail */}
            {selectedLogicalFlow && (
                <Box
                    bg='gray.800'
                    borderRadius='lg'
                    border='1px solid'
                    borderColor='gray.600'
                    mt={3}
                    p={4}
                >
                    <Flex justify='space-between' align='center' mb={3}>
                        <Box>
                            <Text color='white' fontWeight='bold' fontSize='sm'>
                                {selectedLogicalFlow.sourceNamespace}/
                                {selectedLogicalFlow.sourceName}
                                {' → '}
                                {selectedLogicalFlow.destNamespace}/
                                {selectedLogicalFlow.destName}
                            </Text>
                            <Flex gap={4} mt={1} fontSize='xs' color='gray.400'>
                                <Text>
                                    {selectedLogicalFlow.protocol}:
                                    {selectedLogicalFlow.destPort}
                                </Text>
                                <Text>
                                    {formatValue(selectedLogicalFlow.volume, metric)}
                                </Text>
                                <Text
                                    color={ACTION_COLORS[selectedLogicalFlow.action] || 'gray.400'}
                                    fontWeight='bold'
                                >
                                    {selectedLogicalFlow.action}
                                </Text>
                            </Flex>
                        </Box>
                        <Flex gap={3} align='center'>
                            {onFlowSelect && (
                                <Text
                                    color='blue.300'
                                    fontSize='xs'
                                    cursor='pointer'
                                    onClick={() =>
                                        onFlowSelect(
                                            selectedLogicalFlow.sourceName,
                                            selectedLogicalFlow.sourceNamespace,
                                            selectedLogicalFlow.destName,
                                            selectedLogicalFlow.destNamespace,
                                        )
                                    }
                                    _hover={{ color: 'blue.200' }}
                                >
                                    View in Topology →
                                </Text>
                            )}
                            <Text
                                color='gray.400'
                                fontSize='xs'
                                cursor='pointer'
                                onClick={() => setSelectedFlow(null)}
                                _hover={{ color: 'white' }}
                            >
                                ✕
                            </Text>
                        </Flex>
                    </Flex>

                    <Flex gap={6}>
                        <Box flex={1}>
                            <Text fontSize='xs' color='gray.400' fontWeight='bold' mb={1}>
                                EGRESS POLICIES (source-side)
                            </Text>
                            {selectedLogicalFlow.egressPolicies.length > 0 ? (
                                <Table size='sm' variant='simple'>
                                    <Tbody>
                                        {selectedLogicalFlow.egressPolicies.map((p, i) => (
                                            <Tr key={i}>
                                                <Td color='gray.300' fontSize='xs' px={2} py={1}>
                                                    {p.tier || 'profile'}
                                                </Td>
                                                <Td color='gray.200' fontSize='xs' px={2} py={1}>
                                                    {p.name}
                                                </Td>
                                                <Td fontSize='xs' px={2} py={1}>
                                                    <Text
                                                        color={ACTION_COLORS[p.action] || 'gray.300'}
                                                        fontWeight='bold'
                                                    >
                                                        {p.action}
                                                    </Text>
                                                </Td>
                                            </Tr>
                                        ))}
                                    </Tbody>
                                </Table>
                            ) : (
                                <Text color='gray.500' fontSize='xs'>No egress policy data</Text>
                            )}
                        </Box>
                        <Box flex={1}>
                            <Text fontSize='xs' color='gray.400' fontWeight='bold' mb={1}>
                                INGRESS POLICIES (dest-side)
                            </Text>
                            {selectedLogicalFlow.ingressPolicies.length > 0 ? (
                                <Table size='sm' variant='simple'>
                                    <Tbody>
                                        {selectedLogicalFlow.ingressPolicies.map((p, i) => (
                                            <Tr key={i}>
                                                <Td color='gray.300' fontSize='xs' px={2} py={1}>
                                                    {p.tier || 'profile'}
                                                </Td>
                                                <Td color='gray.200' fontSize='xs' px={2} py={1}>
                                                    {p.name}
                                                </Td>
                                                <Td fontSize='xs' px={2} py={1}>
                                                    <Text
                                                        color={ACTION_COLORS[p.action] || 'gray.300'}
                                                        fontWeight='bold'
                                                    >
                                                        {p.action}
                                                    </Text>
                                                </Td>
                                            </Tr>
                                        ))}
                                    </Tbody>
                                </Table>
                            ) : (
                                <Text color='gray.500' fontSize='xs'>No ingress policy data</Text>
                            )}
                        </Box>
                    </Flex>
                </Box>
            )}
        </Box>
    );
};

export default DualSankeyDiagram;
