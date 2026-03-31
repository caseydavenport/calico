import React from 'react';
import { FlowLog } from '@/types/render';
import { Policy } from '@/types/api';
import { Box, Flex, Text, Table, Tbody, Tr, Td } from '@chakra-ui/react';
import { AnimatePresence, motion } from 'framer-motion';

const MotionBox = motion(Box);

type Props = {
    flows: FlowLog[];
    width: number;
    height: number;
    metric?: 'bytes' | 'packets';
};

const ACTION_COLORS: Record<string, string> = {
    Allow: '#38A169', 'Default Allow': '#68D391',
    Deny: '#E53E3E', 'Default Deny': '#FC8181',
    Pass: '#3182CE', 'N/A': '#718096',
};

const toNum = (v: string | number | undefined): number => {
    if (v === undefined || v === null) return 0;
    if (typeof v === 'number') return v;
    return parseInt(v, 10) || 0;
};

const formatBytes = (b: number): string => {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / (1024 * 1024)).toFixed(1)} MB`;
};

const shortKind = (kind: string): string => {
    const map: Record<string, string> = {
        CalicoNetworkPolicy: 'CNP', GlobalNetworkPolicy: 'GNP',
        NetworkPolicy: 'KNP', Profile: 'Profile',
    };
    return map[kind] || kind;
};

// ── Normalize a flow's policy trace into steps ──────────────────────

type Step = {
    id: string;
    label: string;
    shortLabel: string;
    tier: string;
    action: string;
    kind: string;
    isTerminal: boolean;
};

const normalizeTrace = (policies: Policy[]): Step[] => {
    const sorted = [...policies].sort((a, b) => (a.policy_index ?? 0) - (b.policy_index ?? 0));
    const steps: Step[] = [];

    for (const p of sorted) {
        const isKns = p.kind === 'Profile' && p.name.startsWith('kns.');
        const isTrigger = !!p.trigger;

        if (isTrigger) {
            const trigger = p.trigger as Policy;
            steps.push({
                id: `${trigger.kind}:${trigger.tier || ''}/${trigger.name}`,
                label: `${shortKind(trigger.kind)}: ${trigger.name}`,
                shortLabel: trigger.name.replace(/.*\./, ''),
                tier: trigger.tier || '',
                action: 'N/A',
                kind: trigger.kind,
                isTerminal: false,
            });
            const act = p.action === 'Deny' ? 'Default Deny' : p.action;
            steps.push({
                id: `eot:${p.tier || 'default'}:${act}`,
                label: `End of Tier ${p.tier || 'default'}`,
                shortLabel: `End of ${p.tier || 'default'}`,
                tier: p.tier || '',
                action: act,
                kind: 'EndOfTier',
                isTerminal: true,
            });
            break;
        }

        if (isKns) {
            steps.push({
                id: 'profile:default-allow',
                label: 'Default Allow (Profile)',
                shortLabel: 'Default Allow',
                tier: '', action: 'Allow', kind: 'Profile',
                isTerminal: true,
            });
            break;
        }

        steps.push({
            id: `${p.kind}:${p.tier || ''}/${p.namespace ? p.namespace + '/' : ''}${p.name}`,
            label: `${shortKind(p.kind)}: ${p.name}`,
            shortLabel: p.name.replace(/.*\./, ''),
            tier: p.tier || '',
            action: p.action,
            kind: p.kind,
            isTerminal: p.action === 'Deny' || p.action === 'Allow',
        });

        if (p.action === 'Deny') break;
    }

    return steps;
};

// ── Build a DAG of unique policy nodes with flow paths ──────────────

type FlowPath = {
    stepIds: string[];
    volume: number;
    flowCount: number;
    action: string;
    sources: Set<string>;
    dests: Set<string>;
};

type DAGNode = {
    id: string;
    step: Step;
    col: number;       // column (evaluation depth)
    row: number;        // assigned during layout
    flowPaths: FlowPath[];  // paths that pass through this node
    totalVolume: number;
};

type DAGEdge = {
    fromId: string;
    toId: string;
    volume: number;
    action: string;
    flowCount: number;
};

const buildDAG = (flows: FlowLog[], metric: 'bytes' | 'packets') => {
    // First, build unique flow paths
    const pathMap = new Map<string, FlowPath>();

    for (const f of flows) {
        const policies = f.policies?.['enforced'] || [];
        const steps = normalizeTrace(policies);
        const stepIds = steps.map((s) => s.id);
        const key = stepIds.join('→');
        const vol = metric === 'bytes'
            ? toNum(f.bytes_in) + toNum(f.bytes_out)
            : toNum(f.packets_in) + toNum(f.packets_out);

        const existing = pathMap.get(key);
        if (existing) {
            existing.volume += vol;
            existing.flowCount++;
            existing.sources.add(`${f.source_namespace}/${f.source_name}`);
            existing.dests.add(`${f.dest_namespace}/${f.dest_name}`);
        } else {
            pathMap.set(key, {
                stepIds,
                volume: vol,
                flowCount: 1,
                action: steps.length > 0 ? steps[steps.length - 1].action : f.action,
                sources: new Set([`${f.source_namespace}/${f.source_name}`]),
                dests: new Set([`${f.dest_namespace}/${f.dest_name}`]),
            });
        }
    }

    const paths = Array.from(pathMap.values()).sort((a, b) => b.volume - a.volume);

    // Collect all unique steps across all flows
    const stepMap = new Map<string, Step>();
    for (const f of flows) {
        const policies = f.policies?.['enforced'] || [];
        for (const step of normalizeTrace(policies)) {
            if (!stepMap.has(step.id)) stepMap.set(step.id, step);
        }
    }

    // Build tier ordering: collect unique tiers in the order they appear
    // across all traces. This determines column assignment.
    // Tier normalization:
    // - Explicit tier policies (including ones that Allow/Deny) stay in their tier
    // - EndOfTier (default deny) and Profile (default allow) go to '_outcome_'
    //   since they represent fallthrough outcomes, not explicit policy decisions
    // - Trigger policies (N/A) stay in their tier
    const normTier = (step: Step) => {
        // EndOfTier default deny → outcome column
        if (step.kind === 'EndOfTier') return '_outcome_';
        // Profile default allow → outcome column
        if (step.kind === 'Profile' && step.isTerminal) return '_outcome_';
        // Everything else stays in its tier
        const t = step.tier;
        if (!t || t === '') return 'default';
        return t;
    };

    const tierOrder: string[] = [];
    const tierSet = new Set<string>();
    for (const path of paths) {
        for (const stepId of path.stepIds) {
            const step = stepMap.get(stepId);
            if (!step) continue;
            const tier = normTier(step);
            if (!tierSet.has(tier)) {
                tierSet.add(tier);
                tierOrder.push(tier);
            }
        }
    }
    // Ensure _outcome_ is always last
    if (tierSet.has('_outcome_')) {
        const idx = tierOrder.indexOf('_outcome_');
        if (idx >= 0 && idx < tierOrder.length - 1) {
            tierOrder.splice(idx, 1);
        }
        tierOrder.push('_outcome_');
    }
    const tierColMap = new Map<string, number>();
    tierOrder.forEach((t, i) => tierColMap.set(t, i));

    // Build DAG nodes: each unique policy step is one node, column = tier
    // Key: stepId (unique per policy, shared across traces)
    const dagNodes = new Map<string, DAGNode>();
    const dagEdges: DAGEdge[] = [];
    const edgeSet = new Set<string>();

    for (const path of paths) {
        let prevNodeKey: string | null = null;

        for (let i = 0; i < path.stepIds.length; i++) {
            const stepId = path.stepIds[i];
            const nodeKey = stepId; // shared across traces!
            const step = stepMap.get(stepId);
            if (!step) continue;

            const tier = normTier(step);
            const col = tierColMap.get(tier) ?? i;

            if (!dagNodes.has(nodeKey)) {
                dagNodes.set(nodeKey, {
                    id: nodeKey,
                    step,
                    col,
                    row: 0,
                    flowPaths: [],
                    totalVolume: 0,
                });
            }
            const node = dagNodes.get(nodeKey)!;
            node.flowPaths.push(path);
            node.totalVolume += path.volume;

            if (prevNodeKey && prevNodeKey !== nodeKey) {
                const edgeKey = `${prevNodeKey}→${nodeKey}`;
                if (!edgeSet.has(edgeKey)) {
                    edgeSet.add(edgeKey);
                    dagEdges.push({
                        fromId: prevNodeKey,
                        toId: nodeKey,
                        volume: 0,
                        action: step.action,
                        flowCount: 0,
                    });
                }
                const edge = dagEdges.find((e) => `${e.fromId}→${e.toId}` === edgeKey);
                if (edge) {
                    edge.volume += path.volume;
                    edge.flowCount += path.flowCount;
                }
            }

            prevNodeKey = nodeKey;
        }
    }

    // Assign rows: within each column, sort by volume and assign sequential rows
    const cols = new Map<number, DAGNode[]>();
    for (const node of dagNodes.values()) {
        const arr = cols.get(node.col) || [];
        arr.push(node);
        cols.set(node.col, arr);
    }
    for (const [, colNodes] of cols) {
        colNodes.sort((a, b) => b.totalVolume - a.totalVolume);
        colNodes.forEach((n, i) => { n.row = i; });
    }

    const maxCol = Math.max(0, ...Array.from(dagNodes.values()).map((n) => n.col));
    const maxRow = Math.max(0, ...Array.from(dagNodes.values()).map((n) => n.row));

    return { nodes: Array.from(dagNodes.values()), edges: dagEdges, maxCol, maxRow, paths, tierOrder, tierColMap };
};

// ── Component ───────────────────────────────────────────────────────

const DOT_R = 10;
const COL_SPACING = 220;
const ROW_SPACING = 60;
const LEFT_PAD = 40;
const TOP_PAD = 50;

const PolicyTreeGraph: React.FC<Props> = ({ flows, width, height, metric = 'bytes' }) => {
    const [hoveredNode, setHoveredNode] = React.useState<string | null>(null);
    const [selectedNode, setSelectedNode] = React.useState<string | null>(null);
    const [tooltipContent, setTooltipContent] = React.useState('');
    const [tooltipPos, setTooltipPos] = React.useState({ x: 0, y: 0 });

    const dag = React.useMemo(() => buildDAG(flows, metric), [flows, metric]);

    const svgWidth = Math.max(width, LEFT_PAD + (dag.maxCol + 2) * COL_SPACING);
    const svgHeight = Math.max(height, TOP_PAD + (dag.maxRow + 2) * ROW_SPACING);

    const maxVol = Math.max(...dag.nodes.map((n) => n.totalVolume), 1);
    const maxEdgeVol = Math.max(...dag.edges.map((e) => e.volume), 1);

    const nodePos = React.useMemo(() => {
        const map = new Map<string, { x: number; y: number }>();
        for (const n of dag.nodes) {
            map.set(n.id, {
                x: LEFT_PAD + (n.col + 0.5) * COL_SPACING,
                y: TOP_PAD + n.row * ROW_SPACING + ROW_SPACING / 2,
            });
        }
        return map;
    }, [dag]);

    const selectedDAGNode = dag.nodes.find((n) => n.id === selectedNode);

    if (dag.nodes.length === 0) {
        return (
            <Flex align='center' justify='center' h={height} color='gray.500'>
                <Text fontFamily='monospace'>No policy trace data available.</Text>
            </Flex>
        );
    }

    const curvedLink = (x1: number, y1: number, x2: number, y2: number) => {
        const mx = (x1 + x2) / 2;
        return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
    };

    // Highlight: when hovering a node, highlight all edges on paths through it
    const highlightedEdges = React.useMemo(() => {
        if (!hoveredNode && !selectedNode) return null;
        const nodeId = hoveredNode || selectedNode;
        const node = dag.nodes.find((n) => n.id === nodeId);
        if (!node) return null;

        const edgeKeys = new Set<string>();
        for (const path of node.flowPaths) {
            for (let i = 0; i < path.stepIds.length - 1; i++) {
                edgeKeys.add(`${path.stepIds[i]}→${path.stepIds[i + 1]}`);
            }
        }
        return edgeKeys;
    }, [hoveredNode, selectedNode, dag]);

    // Column headers from tier ordering
    const tierCols = React.useMemo(() => {
        const map = new Map<number, string>();
        for (const [tier, col] of dag.tierColMap) {
            const label = tier === '_outcome_' ? 'outcome' : tier;
            map.set(col, label);
        }
        return map;
    }, [dag]);

    return (
        <Box position='relative' h='100%'>
            <Box overflowX='auto' overflowY='auto' h='100%'>
                <svg width={svgWidth} height={svgHeight}>
                    {/* Column headers (tiers) */}
                    {Array.from(tierCols.entries()).map(([col, tier]) => (
                        <text
                            key={`tier-${col}`}
                            x={LEFT_PAD + (col + 0.5) * COL_SPACING}
                            y={20}
                            textAnchor='middle'
                            fontSize={10}
                            fontFamily='monospace'
                            fontWeight='bold'
                            fill='#4A5568'
                        >
                            {tier}
                        </text>
                    ))}

                    {/* Column guide lines */}
                    {Array.from(tierCols.keys()).map((col) => (
                        <line
                            key={`guide-${col}`}
                            x1={LEFT_PAD + (col + 0.5) * COL_SPACING}
                            y1={30}
                            x2={LEFT_PAD + (col + 0.5) * COL_SPACING}
                            y2={svgHeight}
                            stroke='#1E2533'
                            strokeWidth={1}
                        />
                    ))}

                    {/* Edges */}
                    {dag.edges.map((edge) => {
                        const from = nodePos.get(edge.fromId);
                        const to = nodePos.get(edge.toId);
                        if (!from || !to) return null;

                        const w = 2 + (Math.log(edge.volume + 1) / Math.log(maxEdgeVol + 1)) * 10;
                        const edgeKey = `${edge.fromId}→${edge.toId}`;
                        const isHighlighted = !highlightedEdges || highlightedEdges.has(edgeKey);
                        const isDeny = edge.action === 'Deny' || edge.action === 'Default Deny' || edge.action === 'N/A';
                        const color = ACTION_COLORS[edge.action] || '#4A5568';

                        return (
                            <g key={edgeKey}>
                                <path
                                    d={curvedLink(from.x + DOT_R, from.y, to.x - DOT_R, to.y)}
                                    fill='none'
                                    stroke={color}
                                    strokeWidth={w}
                                    strokeOpacity={isHighlighted ? 0.5 : 0.06}
                                    strokeLinecap='round'
                                    style={{ transition: 'stroke-opacity 0.15s ease' }}
                                />
                                {/* Animated direction on highlighted edges */}
                                {isHighlighted && !isDeny && (
                                    <path
                                        d={curvedLink(from.x + DOT_R, from.y, to.x - DOT_R, to.y)}
                                        fill='none'
                                        stroke='rgba(255,255,255,0.3)'
                                        strokeWidth={Math.max(1.5, w * 0.3)}
                                        strokeDasharray='4,12'
                                        strokeLinecap='round'
                                    >
                                        <animate attributeName='stroke-dashoffset' from='16' to='0' dur='1s' repeatCount='indefinite' />
                                    </path>
                                )}
                            </g>
                        );
                    })}

                    {/* Entry lines — every node that is the FIRST step of a trace gets a line from the left */}
                    {dag.nodes.filter((n) => {
                        // Is this node the first step of any flow path?
                        return n.flowPaths.some((p) => p.stepIds[0] === n.id);
                    }).map((n) => {
                        const pos = nodePos.get(n.id);
                        if (!pos) return null;
                        const entryPaths = n.flowPaths.filter((p) => p.stepIds[0] === n.id);
                        const entryVol = entryPaths.reduce((s, p) => s + p.volume, 0);
                        const w = 2 + (Math.log(entryVol + 1) / Math.log(maxVol + 1)) * 10;
                        const isHighlighted = !highlightedEdges ||
                            entryPaths.some((p) => {
                                const node = dag.nodes.find((nn) => nn.id === (hoveredNode || selectedNode));
                                return node?.flowPaths.includes(p);
                            });
                        return (
                            <path
                                key={`entry-${n.id}`}
                                d={`M0,${pos.y} C${pos.x * 0.3},${pos.y} ${pos.x * 0.6},${pos.y} ${pos.x - DOT_R},${pos.y}`}
                                fill='none'
                                stroke='#4A5568'
                                strokeWidth={w}
                                strokeOpacity={isHighlighted ? 0.3 : 0.06}
                                strokeLinecap='round'
                                style={{ transition: 'stroke-opacity 0.15s ease' }}
                            />
                        );
                    })}

                    {/* Nodes */}
                    {dag.nodes.map((n) => {
                        const pos = nodePos.get(n.id);
                        if (!pos) return null;
                        const isHovered = hoveredNode === n.id;
                        const isSelected = selectedNode === n.id;
                        const step = n.step;

                        const color = step.kind === 'EndOfTier'
                            ? ACTION_COLORS[step.action] || '#718096'
                            : step.isTerminal
                              ? ACTION_COLORS[step.action] || '#38A169'
                              : step.action === 'N/A'
                                ? '#718096'
                                : ACTION_COLORS[step.action] || '#3182CE';

                        const r = DOT_R + (Math.log(n.totalVolume + 1) / Math.log(maxVol + 1)) * 4;
                        const highlighted = !highlightedEdges ||
                            n.flowPaths.some((p) => p.stepIds.includes(n.id));

                        return (
                            <g
                                key={n.id}
                                style={{ cursor: 'pointer' }}
                                onClick={() => setSelectedNode(isSelected ? null : n.id)}
                                onMouseEnter={(e) => {
                                    setHoveredNode(n.id);
                                    setTooltipContent(
                                        `${step.label}\n${step.tier ? `Tier: ${step.tier}\n` : ''}Action: ${step.action}\n${n.flowPaths.length} unique traces · ${formatBytes(n.totalVolume)}`,
                                    );
                                    setTooltipPos({ x: e.clientX, y: e.clientY });
                                }}
                                onMouseLeave={() => { setHoveredNode(null); setTooltipContent(''); }}
                            >
                                <circle
                                    cx={pos.x} cy={pos.y} r={r}
                                    fill={color}
                                    stroke={isSelected ? '#FFF' : isHovered ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.15)'}
                                    strokeWidth={isSelected ? 2.5 : isHovered ? 2 : 1}
                                    opacity={highlighted ? 1 : 0.15}
                                    style={{ transition: 'opacity 0.15s ease, stroke 0.15s ease' }}
                                />
                                {/* Always show short label */}
                                <text
                                    x={pos.x} y={pos.y + r + 14}
                                    textAnchor='middle'
                                    fontSize={10}
                                    fontFamily='monospace'
                                    fill={highlighted ? '#CBD5E0' : '#2D3748'}
                                    fontWeight={isSelected ? 'bold' : 'normal'}
                                    style={{ transition: 'fill 0.15s ease' }}
                                >
                                    {step.shortLabel}
                                </text>
                                {/* Action label for terminal nodes */}
                                {step.isTerminal && (
                                    <text
                                        x={pos.x} y={pos.y - r - 6}
                                        textAnchor='middle'
                                        fontSize={9}
                                        fontFamily='monospace'
                                        fontWeight='bold'
                                        fill={color}
                                        opacity={highlighted ? 1 : 0.15}
                                        style={{ transition: 'opacity 0.15s ease' }}
                                    >
                                        {step.action}
                                    </text>
                                )}
                                {/* Flow count */}
                                {n.flowPaths.length > 1 && (
                                    <text
                                        x={pos.x} y={pos.y + r + 25}
                                        textAnchor='middle'
                                        fontSize={8}
                                        fontFamily='monospace'
                                        fill='#4A5568'
                                    >
                                        {n.flowPaths.reduce((s, p) => s + p.flowCount, 0)} flows
                                    </text>
                                )}
                            </g>
                        );
                    })}
                </svg>
            </Box>

            {/* Tooltip */}
            {tooltipContent && (
                <Box
                    position='fixed' left={tooltipPos.x + 14} top={tooltipPos.y - 24}
                    bg='gray.900' color='white' px={3} py={1.5}
                    borderRadius='lg' fontSize='xs' fontFamily='monospace'
                    pointerEvents='none' zIndex={1000} whiteSpace='pre-line'
                    border='1px solid' borderColor='gray.600' boxShadow='lg'
                >
                    {tooltipContent}
                </Box>
            )}

            {/* Detail panel */}
            <AnimatePresence>
                {selectedDAGNode && (
                    <MotionBox
                        position='fixed' bottom={0} left={0} right={0}
                        bg='gray.800' borderTop='1px solid' borderColor='gray.600'
                        p={5} maxH='35vh' overflowY='auto'
                        initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
                        transition={{ type: 'spring', damping: 28, stiffness: 300 }}
                        boxShadow='0 -8px 30px rgba(0,0,0,0.5)' zIndex={100}
                    >
                        <Flex justify='space-between' align='center' mb={3}>
                            <Box>
                                <Text color='white' fontWeight='bold' fontSize='md' fontFamily='monospace'>
                                    {selectedDAGNode.step.label}
                                    {selectedDAGNode.step.tier && (
                                        <Text as='span' color='gray.400' fontWeight='normal' ml={2}>
                                            tier: {selectedDAGNode.step.tier}
                                        </Text>
                                    )}
                                </Text>
                                <Flex gap={4} mt={1} fontSize='sm' color='gray.400' fontFamily='monospace'>
                                    <Text>{selectedDAGNode.flowPaths.reduce((s, p) => s + p.flowCount, 0)} flows</Text>
                                    <Text>{formatBytes(selectedDAGNode.totalVolume)}</Text>
                                    <Text color={ACTION_COLORS[selectedDAGNode.step.action] || 'gray.400'} fontWeight='bold'>
                                        {selectedDAGNode.step.action}
                                    </Text>
                                </Flex>
                            </Box>
                            <Text color='gray.500' fontSize='sm' cursor='pointer'
                                onClick={() => setSelectedNode(null)} _hover={{ color: 'white' }} px={2}>✕</Text>
                        </Flex>

                        <Text fontSize='xs' color='gray.500' fontWeight='bold' mb={2} fontFamily='monospace'>
                            FLOW PATHS THROUGH THIS POLICY
                        </Text>
                        <Table size='sm' variant='unstyled'>
                            <Tbody>
                                {selectedDAGNode.flowPaths.map((path, i) => (
                                    <Tr key={i} _hover={{ bg: 'rgba(255,255,255,0.03)' }}>
                                        <Td px={2} py={1.5} fontSize='xs' fontFamily='monospace' color='gray.300' maxW='200px'>
                                            {Array.from(path.sources).map((s) => s.split('/').pop()).join(', ')}
                                        </Td>
                                        <Td px={1} py={1.5} fontSize='xs' fontFamily='monospace' color='gray.500'>→</Td>
                                        <Td px={2} py={1.5} fontSize='xs' fontFamily='monospace' color='gray.300' maxW='200px'>
                                            {Array.from(path.dests).map((s) => s.split('/').pop()).join(', ')}
                                        </Td>
                                        <Td px={2} py={1.5} fontSize='xs' fontFamily='monospace'>
                                            <Text color={ACTION_COLORS[path.action] || 'gray.400'} fontWeight='bold'>
                                                {path.action}
                                            </Text>
                                        </Td>
                                        <Td px={2} py={1.5} fontSize='xs' fontFamily='monospace' color='gray.400' isNumeric>
                                            {formatBytes(path.volume)}
                                        </Td>
                                        <Td px={2} py={1.5} fontSize='xs' fontFamily='monospace' color='gray.500' isNumeric>
                                            {path.flowCount}x
                                        </Td>
                                    </Tr>
                                ))}
                            </Tbody>
                        </Table>
                    </MotionBox>
                )}
            </AnimatePresence>
        </Box>
    );
};

export default PolicyTreeGraph;
