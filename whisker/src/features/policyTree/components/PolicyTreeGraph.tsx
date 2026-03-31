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
    Allow: '#38A169',
    'Default Allow': '#68D391',
    Deny: '#E53E3E',
    'Default Deny': '#FC8181',
    Pass: '#3182CE',
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

const shortKind = (kind: string) => {
    const map: Record<string, string> = {
        CalicoNetworkPolicy: 'CNP',
        GlobalNetworkPolicy: 'GNP',
        NetworkPolicy: 'KNP',
        Profile: 'Profile',
    };
    return map[kind] || kind;
};

// ── Data model ──────────────────────────────────────────────────────

// A normalized policy step in a flow's trace
type PolicyStep = {
    id: string;        // unique ID for this policy
    label: string;     // display label
    tier: string;
    action: string;
    kind: string;
    isTrigger: boolean;
    isKnsProfile: boolean;
};

// A trace is the ordered list of policy steps a flow traverses
type FlowTrace = {
    steps: PolicyStep[];
    terminalAction: string;
    volume: number;
    flowCount: number;
    sourceNames: Set<string>;
    destNames: Set<string>;
};

const normalizePolicies = (policies: Policy[]): PolicyStep[] => {
    const sorted = [...policies].sort((a, b) => (a.policy_index ?? 0) - (b.policy_index ?? 0));
    const steps: PolicyStep[] = [];

    for (const p of sorted) {
        const isKns = p.kind === 'Profile' && p.name.startsWith('kns.');
        const isTrigger = !!p.trigger;

        if (isTrigger) {
            const trigger = p.trigger as Policy;
            steps.push({
                id: `${trigger.kind}:${trigger.tier || ''}/${trigger.name}`,
                label: `${shortKind(trigger.kind)}:${trigger.name}`,
                tier: trigger.tier || '',
                action: 'N/A',
                kind: trigger.kind,
                isTrigger: true,
                isKnsProfile: false,
            });
            steps.push({
                id: `eot:${p.tier || 'default'}`,
                label: `End of ${p.tier || 'default'}`,
                tier: p.tier || '',
                action: p.action === 'Deny' ? 'Default Deny' : p.action,
                kind: 'EndOfTier',
                isTrigger: false,
                isKnsProfile: false,
            });
            break;
        }

        if (isKns) {
            steps.push({
                id: 'profile:default-allow',
                label: 'Default Allow',
                tier: '',
                action: 'Allow',
                kind: 'Profile',
                isTrigger: false,
                isKnsProfile: true,
            });
            break;
        }

        steps.push({
            id: `${p.kind}:${p.tier || ''}/${p.namespace ? p.namespace + '/' : ''}${p.name}`,
            label: `${shortKind(p.kind)}:${p.name}`,
            tier: p.tier || '',
            action: p.action,
            kind: p.kind,
            isTrigger: false,
            isKnsProfile: false,
        });

        if (p.action === 'Deny') break;
    }

    return steps;
};

// Build unique traces from flows, merging identical policy paths
const buildTraces = (flows: FlowLog[], metric: 'bytes' | 'packets'): FlowTrace[] => {
    const map = new Map<string, FlowTrace>();

    for (const f of flows) {
        const policies = f.policies?.['enforced'] || [];
        const steps = normalizePolicies(policies);
        const key = steps.map((s) => s.id).join('→');

        const vol = metric === 'bytes'
            ? toNum(f.bytes_in) + toNum(f.bytes_out)
            : toNum(f.packets_in) + toNum(f.packets_out);

        const last = steps[steps.length - 1];
        const termAction = last?.action || f.action;

        const existing = map.get(key);
        if (existing) {
            existing.volume += vol;
            existing.flowCount++;
            existing.sourceNames.add(`${f.source_namespace}/${f.source_name}`);
            existing.destNames.add(`${f.dest_namespace}/${f.dest_name}`);
        } else {
            map.set(key, {
                steps,
                terminalAction: termAction,
                volume: vol,
                flowCount: 1,
                sourceNames: new Set([`${f.source_namespace}/${f.source_name}`]),
                destNames: new Set([`${f.dest_namespace}/${f.dest_name}`]),
            });
        }
    }

    return Array.from(map.values()).sort((a, b) => b.volume - a.volume);
};

// ── Tree layout ─────────────────────────────────────────────────────

// Build a trie from traces: shared prefixes merge into one path
type TreeNode = {
    step: PolicyStep | null;  // null for root
    children: Map<string, TreeNode>;
    traces: FlowTrace[];      // traces that pass through this node
    terminalTraces: FlowTrace[]; // traces that END at this node
    depth: number;
    yIndex: number;            // assigned during layout
};

const buildTree = (traces: FlowTrace[]): TreeNode => {
    const root: TreeNode = {
        step: null,
        children: new Map(),
        traces: [...traces],
        terminalTraces: [],
        depth: 0,
        yIndex: 0,
    };

    for (const trace of traces) {
        let node = root;
        for (let i = 0; i < trace.steps.length; i++) {
            const step = trace.steps[i];
            let child = node.children.get(step.id);
            if (!child) {
                child = {
                    step,
                    children: new Map(),
                    traces: [],
                    terminalTraces: [],
                    depth: i + 1,
                    yIndex: 0,
                };
                node.children.set(step.id, child);
            }
            child.traces.push(trace);
            node = child;

            if (i === trace.steps.length - 1) {
                node.terminalTraces.push(trace);
            }
        }
    }

    return root;
};

// Assign Y indices to leaf nodes, then propagate up
let nextY = 0;
const assignYIndices = (node: TreeNode) => {
    if (node.children.size === 0 || node.terminalTraces.length > 0) {
        // Leaf or terminal: assign a Y slot
        if (node.children.size === 0) {
            node.yIndex = nextY++;
        } else {
            // Has both terminal traces and children
            node.yIndex = nextY++;
        }
    }

    const children = Array.from(node.children.values());
    for (const child of children) {
        assignYIndices(child);
    }

    // Non-leaf: center among children
    if (node.children.size > 0 && node.terminalTraces.length === 0) {
        const ys = children.map((c) => c.yIndex);
        node.yIndex = (Math.min(...ys) + Math.max(...ys)) / 2;
    }
};

// ── Rendering ───────────────────────────────────────────────────────

type RenderedNode = {
    x: number;
    y: number;
    step: PolicyStep;
    traces: FlowTrace[];
    terminalTraces: FlowTrace[];
    isTerminal: boolean;
};

type RenderedEdge = {
    x1: number; y1: number;
    x2: number; y2: number;
    volume: number;
    action: string;
};

const LANE_H = 32;
const DOT_R = 8;
const LEFT_MARGIN = 20;
const RIGHT_MARGIN = 20;
const TOP_MARGIN = 40;

const PolicyTreeGraph: React.FC<Props> = ({
    flows,
    width,
    height,
    metric = 'bytes',
}) => {
    const [hoveredNode, setHoveredNode] = React.useState<string | null>(null);
    const [selectedNode, setSelectedNode] = React.useState<string | null>(null);
    const [tooltipContent, setTooltipContent] = React.useState('');
    const [tooltipPos, setTooltipPos] = React.useState({ x: 0, y: 0 });

    const traces = React.useMemo(
        () => buildTraces(flows, metric),
        [flows, metric],
    );

    const { renderedNodes, renderedEdges, svgHeight, maxDepth } = React.useMemo(() => {
        if (traces.length === 0) return { renderedNodes: [], renderedEdges: [], svgHeight: height, maxDepth: 0 };

        const tree = buildTree(traces);
        nextY = 0;
        assignYIndices(tree);
        const totalLanes = nextY;

        const maxD = traces.reduce((m, t) => Math.max(m, t.steps.length), 0);
        const colWidth = maxD > 0 ? (width - LEFT_MARGIN - RIGHT_MARGIN) / (maxD + 1) : 100;
        const svgH = Math.max(height, TOP_MARGIN + totalLanes * LANE_H + 20);

        const rNodes: RenderedNode[] = [];
        const rEdges: RenderedEdge[] = [];
        const nodePositions = new Map<string, { x: number; y: number }>();

        // Flatten tree to rendered nodes
        const visit = (node: TreeNode, parentKey: string | null) => {
            if (!node.step) {
                // Root: visit children
                for (const child of node.children.values()) {
                    visit(child, null);
                }
                return;
            }

            const x = LEFT_MARGIN + node.depth * colWidth;
            const y = TOP_MARGIN + node.yIndex * LANE_H;
            const key = `${node.depth}:${node.step.id}`;

            nodePositions.set(key, { x, y });

            rNodes.push({
                x, y,
                step: node.step,
                traces: node.traces,
                terminalTraces: node.terminalTraces,
                isTerminal: node.terminalTraces.length > 0,
            });

            // Edge from parent
            if (parentKey) {
                const parentPos = nodePositions.get(parentKey);
                if (parentPos) {
                    const totalVol = node.traces.reduce((s, t) => s + t.volume, 0);
                    const action = node.step.action === 'Deny' || node.step.action === 'Default Deny'
                        ? 'Deny'
                        : node.traces[0]?.terminalAction || 'Allow';
                    rEdges.push({
                        x1: parentPos.x, y1: parentPos.y,
                        x2: x, y2: y,
                        volume: totalVol,
                        action,
                    });
                }
            }

            for (const child of node.children.values()) {
                visit(child, key);
            }
        };

        // Root's children connect from the left edge
        for (const child of tree.children.values()) {
            const cx = LEFT_MARGIN + child.depth * colWidth;
            const cy = TOP_MARGIN + child.yIndex * LANE_H;
            const key = `${child.depth}:${child.step!.id}`;
            nodePositions.set(key, { x: cx, y: cy });

            rNodes.push({
                x: cx, y: cy,
                step: child.step!,
                traces: child.traces,
                terminalTraces: child.terminalTraces,
                isTerminal: child.terminalTraces.length > 0,
            });

            // Entry edge from left margin
            const totalVol = child.traces.reduce((s, t) => s + t.volume, 0);
            rEdges.push({
                x1: LEFT_MARGIN - 10, y1: cy,
                x2: cx, y2: cy,
                volume: totalVol,
                action: child.traces[0]?.terminalAction || 'Allow',
            });

            for (const grandchild of child.children.values()) {
                visit(grandchild, key);
            }
        }

        return { renderedNodes: rNodes, renderedEdges: rEdges, svgHeight: svgH, maxDepth: maxD };
    }, [traces, width, height, metric]);

    const maxVol = React.useMemo(
        () => Math.max(...renderedEdges.map((e) => e.volume), 1),
        [renderedEdges],
    );

    const selectedRNode = renderedNodes.find(
        (n) => selectedNode === `${n.x}:${n.y}`,
    );

    if (traces.length === 0) {
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

    return (
        <Box position='relative' h='100%'>
            <Box overflowY='auto' overflowX='auto' h='100%'>
                <svg width={width} height={svgHeight}>
                    {/* Column guide lines */}
                    {Array.from({ length: maxDepth + 1 }, (_, i) => {
                        const x = LEFT_MARGIN + (i + 1) * ((width - LEFT_MARGIN - RIGHT_MARGIN) / (maxDepth + 1));
                        return (
                            <line
                                key={`guide-${i}`}
                                x1={x} y1={TOP_MARGIN - 10}
                                x2={x} y2={svgHeight}
                                stroke='#1E2533'
                                strokeWidth={1}
                            />
                        );
                    })}

                    {/* Edges */}
                    {renderedEdges.map((edge, i) => {
                        const w = 2 + (Math.log(edge.volume + 1) / Math.log(maxVol + 1)) * 8;
                        const color = ACTION_COLORS[edge.action] || '#4A5568';
                        const isRelated = !hoveredNode || renderedNodes.some(
                            (n) => `${n.x}:${n.y}` === hoveredNode &&
                                   ((Math.abs(n.x - edge.x1) < 1 && Math.abs(n.y - edge.y1) < 1) ||
                                    (Math.abs(n.x - edge.x2) < 1 && Math.abs(n.y - edge.y2) < 1)),
                        );
                        return (
                            <path
                                key={`edge-${i}`}
                                d={curvedLink(edge.x1, edge.y1, edge.x2, edge.y2)}
                                fill='none'
                                stroke={color}
                                strokeWidth={w}
                                strokeOpacity={isRelated ? 0.5 : 0.08}
                                strokeLinecap='round'
                                style={{ transition: 'stroke-opacity 0.15s ease' }}
                            />
                        );
                    })}

                    {/* Nodes */}
                    {renderedNodes.map((rn) => {
                        const key = `${rn.x}:${rn.y}`;
                        const isHovered = hoveredNode === key;
                        const isSelected = selectedNode === key;
                        const step = rn.step;

                        // Color by action
                        const color = step.isTrigger
                            ? '#718096'
                            : step.isKnsProfile
                              ? ACTION_COLORS['Default Allow']
                              : step.kind === 'EndOfTier'
                                ? ACTION_COLORS[step.action] || '#718096'
                                : ACTION_COLORS[step.action] || '#3182CE';

                        return (
                            <g
                                key={key}
                                style={{ cursor: 'pointer' }}
                                onClick={() => setSelectedNode(isSelected ? null : key)}
                                onMouseEnter={(e) => {
                                    setHoveredNode(key);
                                    setTooltipContent(
                                        `${step.label}\n${step.tier ? `Tier: ${step.tier}` : ''}\nAction: ${step.action}\n${rn.traces.length} flows · ${formatBytes(rn.traces.reduce((s, t) => s + t.volume, 0))}`,
                                    );
                                    setTooltipPos({ x: e.clientX, y: e.clientY });
                                }}
                                onMouseLeave={() => {
                                    setHoveredNode(null);
                                    setTooltipContent('');
                                }}
                            >
                                {/* Terminal nodes: larger with border */}
                                <circle
                                    cx={rn.x} cy={rn.y}
                                    r={rn.isTerminal ? DOT_R + 2 : DOT_R}
                                    fill={color}
                                    stroke={isSelected ? '#FFF' : isHovered ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.15)'}
                                    strokeWidth={isSelected ? 2.5 : isHovered ? 2 : 1}
                                    style={{ transition: 'stroke 0.15s ease' }}
                                />
                                {/* Terminal action label */}
                                {rn.isTerminal && (
                                    <text
                                        x={rn.x + DOT_R + 8} y={rn.y}
                                        dy='0.35em'
                                        fontSize={10}
                                        fontFamily='monospace'
                                        fontWeight='bold'
                                        fill={color}
                                    >
                                        {rn.terminalTraces[0]?.terminalAction}
                                    </text>
                                )}
                                {/* Policy name: show on hover or if zoomed in enough */}
                                {(isHovered || isSelected) && (
                                    <text
                                        x={rn.x} y={rn.y - DOT_R - 6}
                                        textAnchor='middle'
                                        fontSize={10}
                                        fontFamily='monospace'
                                        fill='#E2E8F0'
                                        fontWeight={isSelected ? 'bold' : 'normal'}
                                    >
                                        {step.label}
                                    </text>
                                )}
                                {/* Flow count badge */}
                                {rn.traces.length > 1 && (
                                    <text
                                        x={rn.x} y={rn.y + DOT_R + 14}
                                        textAnchor='middle'
                                        fontSize={8}
                                        fontFamily='monospace'
                                        fill='#718096'
                                    >
                                        {rn.traces.length} flows
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
                {selectedRNode && (
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
                                    {selectedRNode.step.label}
                                    {selectedRNode.step.tier && (
                                        <Text as='span' color='gray.400' fontWeight='normal' ml={2}>
                                            tier: {selectedRNode.step.tier}
                                        </Text>
                                    )}
                                </Text>
                                <Flex gap={4} mt={1} fontSize='sm' color='gray.400' fontFamily='monospace'>
                                    <Text>{selectedRNode.traces.length} flows</Text>
                                    <Text>
                                        {formatBytes(selectedRNode.traces.reduce((s, t) => s + t.volume, 0))}
                                    </Text>
                                    <Text
                                        color={ACTION_COLORS[selectedRNode.step.action] || 'gray.400'}
                                        fontWeight='bold'
                                    >
                                        {selectedRNode.step.action}
                                    </Text>
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

                        <Text fontSize='xs' color='gray.500' fontWeight='bold' mb={2} fontFamily='monospace'>
                            FLOWS THROUGH THIS POLICY
                        </Text>
                        <Table size='sm' variant='unstyled'>
                            <Tbody>
                                {selectedRNode.traces.map((trace, i) => (
                                    <Tr key={i} _hover={{ bg: 'rgba(255,255,255,0.03)' }}>
                                        <Td px={2} py={1} fontSize='xs' fontFamily='monospace' color='gray.300'>
                                            {Array.from(trace.sourceNames).map((s) => s.split('/').pop()).join(', ')}
                                        </Td>
                                        <Td px={2} py={1} fontSize='xs' fontFamily='monospace' color='gray.500'>
                                            →
                                        </Td>
                                        <Td px={2} py={1} fontSize='xs' fontFamily='monospace' color='gray.300'>
                                            {Array.from(trace.destNames).map((s) => s.split('/').pop()).join(', ')}
                                        </Td>
                                        <Td px={2} py={1} fontSize='xs' fontFamily='monospace'>
                                            <Text color={ACTION_COLORS[trace.terminalAction] || 'gray.400'} fontWeight='bold'>
                                                {trace.terminalAction}
                                            </Text>
                                        </Td>
                                        <Td px={2} py={1} fontSize='xs' fontFamily='monospace' color='gray.400' isNumeric>
                                            {formatBytes(trace.volume)}
                                        </Td>
                                        <Td px={2} py={1} fontSize='xs' fontFamily='monospace' color='gray.500' isNumeric>
                                            {trace.flowCount} flows
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
