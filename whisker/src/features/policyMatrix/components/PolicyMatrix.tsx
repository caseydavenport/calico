import React from 'react';
import { FlowLog } from '@/types/render';
import { Policy } from '@/types/api';
import { Box, Flex, Text, Table, Thead, Tbody, Tr, Th, Td } from '@chakra-ui/react';

type Props = {
    flows: FlowLog[];
    metric?: 'bytes' | 'packets';
};

const ACTION_COLORS: Record<string, string> = {
    Allow: '#38A169',
    'Default Allow': '#68D391',
    Deny: '#E53E3E',
    'Default Deny': '#FC8181',
    Pass: '#3182CE',
    'N/A': '#718096',
};

const ACTION_BG: Record<string, string> = {
    Allow: 'rgba(56, 161, 105, 0.25)',
    'Default Allow': 'rgba(104, 211, 145, 0.2)',
    Deny: 'rgba(229, 62, 62, 0.3)',
    'Default Deny': 'rgba(252, 129, 129, 0.2)',
    Pass: 'rgba(49, 130, 206, 0.15)',
    'N/A': 'rgba(113, 128, 150, 0.1)',
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
        CalicoNetworkPolicy: 'CNP', GlobalNetworkPolicy: 'GNP',
        NetworkPolicy: 'KNP', Profile: 'Profile',
    };
    return map[kind] || kind;
};

const cleanName = (name: string) =>
    name.replace(/-[a-z0-9]{6,10}-\*$/, '-*');

// ── Data model ──────────────────────────────────────────────────────

type FlowEndpoint = {
    name: string;
    namespace: string;
    key: string; // "namespace/name"
};

type PolicyColumn = {
    id: string;
    label: string;
    shortLabel: string;
    tier: string;
    kind: string;
};

type CellData = {
    action: string;        // what this policy did for this flow
    volume: number;
    flowCount: number;
    isTerminal: boolean;   // did evaluation stop here?
};

type MatrixData = {
    rows: FlowEndpoint[];          // source → dest pairs
    columns: PolicyColumn[];       // ordered policies
    tierGroups: { tier: string; startCol: number; endCol: number }[];
    cells: Map<string, CellData>;  // key: "rowIdx:colIdx"
    rowActions: string[];          // final outcome per row
};

const buildMatrix = (flows: FlowLog[], metric: 'bytes' | 'packets'): MatrixData => {
    // Group flows by logical connection (src→dst), merge Src/Dst reporters
    type LogicalFlow = {
        src: FlowEndpoint;
        dst: FlowEndpoint;
        policies: Policy[];
        action: string;
        volume: number;
        flowCount: number;
    };

    const flowMap = new Map<string, LogicalFlow>();
    for (const f of flows) {
        const srcKey = `${f.source_namespace}/${cleanName(f.source_name)}`;
        const dstKey = `${f.dest_namespace}/${cleanName(f.dest_name)}`;
        const key = `${srcKey}→${dstKey}`;
        const vol = metric === 'bytes'
            ? toNum(f.bytes_in) + toNum(f.bytes_out)
            : toNum(f.packets_in) + toNum(f.packets_out);

        const existing = flowMap.get(key);
        const policies = [...(f.policies?.['enforced'] || [])].sort(
            (a, b) => (a.policy_index ?? 0) - (b.policy_index ?? 0),
        );

        if (existing) {
            existing.volume += vol;
            existing.flowCount++;
            // Take the longer policy trace
            if (policies.length > existing.policies.length) {
                existing.policies = policies;
            }
            if (f.action === 'Deny') existing.action = 'Deny';
        } else {
            flowMap.set(key, {
                src: { name: cleanName(f.source_name), namespace: f.source_namespace, key: srcKey },
                dst: { name: cleanName(f.dest_name), namespace: f.dest_namespace, key: dstKey },
                policies,
                action: f.action,
                volume: vol,
                flowCount: 1,
            });
        }
    }

    const logicalFlows = Array.from(flowMap.values()).sort((a, b) => b.volume - a.volume);

    // Collect all unique policies in tier evaluation order
    // Key by policy ID (tier + kind + name), preserve order
    const policyOrderMap = new Map<string, PolicyColumn>();
    const tierOrderSet = new Set<string>();

    for (const lf of logicalFlows) {
        for (const p of lf.policies) {
            const isKns = p.kind === 'Profile' && p.name.startsWith('kns.');
            const isTrigger = !!p.trigger;

            if (isTrigger) {
                const trigger = p.trigger as Policy;
                const tid = `${trigger.tier || 'default'}/${trigger.kind}:${trigger.name}`;
                if (!policyOrderMap.has(tid)) {
                    tierOrderSet.add(trigger.tier || 'default');
                    policyOrderMap.set(tid, {
                        id: tid,
                        label: `${shortKind(trigger.kind)}: ${trigger.name}`,
                        shortLabel: trigger.name.replace(/.*\./, ''),
                        tier: trigger.tier || 'default',
                        kind: trigger.kind,
                    });
                }
                continue;
            }

            if (isKns) continue; // handled as "Default Allow" outcome

            const pid = `${p.tier || 'default'}/${p.kind}:${p.name}`;
            if (!policyOrderMap.has(pid)) {
                tierOrderSet.add(p.tier || 'default');
                policyOrderMap.set(pid, {
                    id: pid,
                    label: `${shortKind(p.kind)}: ${p.name}`,
                    shortLabel: p.name.replace(/.*\./, ''),
                    tier: p.tier || 'default',
                    kind: p.kind,
                });
            }
        }
    }

    const columns = Array.from(policyOrderMap.values());

    // Build tier groups for header spanning
    const tierGroups: { tier: string; startCol: number; endCol: number }[] = [];
    let currentTier = '';
    let startCol = 0;
    columns.forEach((col, i) => {
        if (col.tier !== currentTier) {
            if (currentTier) {
                tierGroups.push({ tier: currentTier, startCol, endCol: i - 1 });
            }
            currentTier = col.tier;
            startCol = i;
        }
    });
    if (currentTier) {
        tierGroups.push({ tier: currentTier, startCol, endCol: columns.length - 1 });
    }

    // Build rows (src→dst pairs) and cells
    const rows: FlowEndpoint[] = [];
    const cells = new Map<string, CellData>();
    const rowActions: string[] = [];
    const colIdxMap = new Map<string, number>();
    columns.forEach((c, i) => colIdxMap.set(c.id, i));

    for (const lf of logicalFlows) {
        const rowIdx = rows.length;
        rows.push({
            name: `${lf.src.name} → ${lf.dst.name}`,
            namespace: `${lf.src.namespace} → ${lf.dst.namespace}`,
            key: `${lf.src.key}→${lf.dst.key}`,
        });

        let terminated = false;
        for (const p of lf.policies) {
            if (terminated) break;

            const isKns = p.kind === 'Profile' && p.name.startsWith('kns.');
            const isTrigger = !!p.trigger;

            if (isTrigger) {
                const trigger = p.trigger as Policy;
                const tid = `${trigger.tier || 'default'}/${trigger.kind}:${trigger.name}`;
                const colIdx = colIdxMap.get(tid);
                if (colIdx !== undefined) {
                    cells.set(`${rowIdx}:${colIdx}`, {
                        action: 'N/A',
                        volume: lf.volume,
                        flowCount: lf.flowCount,
                        isTerminal: false,
                    });
                }
                terminated = true;
                break;
            }

            if (isKns) {
                terminated = true;
                break;
            }

            const pid = `${p.tier || 'default'}/${p.kind}:${p.name}`;
            const colIdx = colIdxMap.get(pid);
            if (colIdx !== undefined) {
                const isTerminal = p.action === 'Allow' || p.action === 'Deny';
                cells.set(`${rowIdx}:${colIdx}`, {
                    action: p.action,
                    volume: lf.volume,
                    flowCount: lf.flowCount,
                    isTerminal,
                });
                if (isTerminal) {
                    terminated = true;
                }
            }
        }

        // Determine final outcome
        const lastPol = lf.policies[lf.policies.length - 1];
        let outcome = lf.action;
        if (lastPol) {
            if (lastPol.trigger) {
                outcome = lastPol.action === 'Deny' ? 'Default Deny' : lastPol.action;
            } else if (lastPol.kind === 'Profile' && lastPol.name.startsWith('kns.')) {
                outcome = 'Default Allow';
            }
        }
        rowActions.push(outcome);
    }

    return { rows, columns, tierGroups, cells, rowActions };
};

// ── Component ───────────────────────────────────────────────────────

const PolicyMatrix: React.FC<Props> = ({ flows, metric = 'bytes' }) => {
    const [hoveredRow, setHoveredRow] = React.useState<number | null>(null);
    const [hoveredCol, setHoveredCol] = React.useState<number | null>(null);
    const [tooltipContent, setTooltipContent] = React.useState('');
    const [tooltipPos, setTooltipPos] = React.useState({ x: 0, y: 0 });

    const matrix = React.useMemo(() => buildMatrix(flows, metric), [flows, metric]);

    if (matrix.rows.length === 0 || matrix.columns.length === 0) {
        return (
            <Flex align='center' justify='center' h='100%' color='gray.500'>
                <Text fontFamily='monospace'>No policy trace data available.</Text>
            </Flex>
        );
    }

    return (
        <Box overflowX='auto' overflowY='auto' h='100%' position='relative'>
            <Table size='sm' variant='unstyled' sx={{ borderCollapse: 'separate', borderSpacing: '1px' }}>
                {/* Tier group headers */}
                <Thead position='sticky' top={0} zIndex={3} bg='gray.900'>
                    <Tr>
                        {/* Flow column header */}
                        <Th
                            position='sticky' left={0} zIndex={4} bg='gray.900'
                            px={3} py={2} minW='200px'
                            color='gray.500' fontSize='10px' fontFamily='monospace' textTransform='none'
                        >
                            Flow
                        </Th>
                        {matrix.tierGroups.map((tg) => (
                            <Th
                                key={tg.tier}
                                colSpan={tg.endCol - tg.startCol + 1}
                                px={1} py={2}
                                textAlign='center'
                                color='gray.400'
                                fontSize='11px'
                                fontFamily='monospace'
                                fontWeight='bold'
                                textTransform='none'
                                borderBottom='2px solid'
                                borderBottomColor='gray.700'
                            >
                                {tg.tier}
                            </Th>
                        ))}
                        {/* Outcome column */}
                        <Th
                            px={3} py={2}
                            color='gray.500' fontSize='10px' fontFamily='monospace' textTransform='none'
                            textAlign='center'
                        >
                            Outcome
                        </Th>
                    </Tr>
                    {/* Policy name headers */}
                    <Tr>
                        <Th
                            position='sticky' left={0} zIndex={4} bg='gray.900'
                            px={3} py={1}
                        />
                        {matrix.columns.map((col, ci) => (
                            <Th
                                key={col.id}
                                px={1} py={1}
                                textAlign='center'
                                color={hoveredCol === ci ? 'white' : 'gray.500'}
                                fontSize='9px'
                                fontFamily='monospace'
                                textTransform='none'
                                fontWeight='normal'
                                maxW='100px'
                                whiteSpace='nowrap'
                                overflow='hidden'
                                textOverflow='ellipsis'
                                onMouseEnter={(e) => {
                                    setHoveredCol(ci);
                                    setTooltipContent(`${col.label}\nTier: ${col.tier}`);
                                    setTooltipPos({ x: e.clientX, y: e.clientY });
                                }}
                                onMouseLeave={() => { setHoveredCol(null); setTooltipContent(''); }}
                                style={{ cursor: 'default', writingMode: 'vertical-rl', textOrientation: 'mixed', height: '80px' }}
                            >
                                {col.shortLabel}
                            </Th>
                        ))}
                        <Th px={3} py={1} />
                    </Tr>
                </Thead>
                <Tbody>
                    {matrix.rows.map((row, ri) => {
                        const isRowHovered = hoveredRow === ri;
                        const outcome = matrix.rowActions[ri];
                        const outcomeColor = ACTION_COLORS[outcome] || '#718096';
                        const outcomeBg = ACTION_BG[outcome] || 'transparent';

                        return (
                            <Tr
                                key={row.key}
                                onMouseEnter={() => setHoveredRow(ri)}
                                onMouseLeave={() => setHoveredRow(null)}
                                bg={isRowHovered ? 'rgba(255,255,255,0.03)' : undefined}
                            >
                                {/* Flow name (sticky left) */}
                                <Td
                                    position='sticky' left={0} zIndex={2}
                                    bg={isRowHovered ? 'gray.800' : 'gray.900'}
                                    px={3} py={2} minW='200px'
                                    borderRight='1px solid' borderRightColor='gray.700'
                                >
                                    <Text fontSize='xs' fontFamily='monospace' color='gray.200' fontWeight='600' noOfLines={1}>
                                        {row.name}
                                    </Text>
                                    <Text fontSize='10px' fontFamily='monospace' color='gray.600' noOfLines={1}>
                                        {row.namespace}
                                    </Text>
                                </Td>

                                {/* Policy cells */}
                                {matrix.columns.map((col, ci) => {
                                    const cell = matrix.cells.get(`${ri}:${ci}`);
                                    const isColHovered = hoveredCol === ci;

                                    if (!cell) {
                                        // Empty cell — flow didn't hit this policy
                                        return (
                                            <Td
                                                key={col.id}
                                                px={1} py={1}
                                                textAlign='center'
                                                bg={isColHovered || isRowHovered ? 'rgba(255,255,255,0.02)' : undefined}
                                            >
                                                <Text fontSize='10px' color='gray.700'>·</Text>
                                            </Td>
                                        );
                                    }

                                    const cellColor = ACTION_COLORS[cell.action] || '#718096';
                                    const cellBg = ACTION_BG[cell.action] || 'transparent';

                                    return (
                                        <Td
                                            key={col.id}
                                            px={1} py={1}
                                            textAlign='center'
                                            bg={cellBg}
                                            borderRadius='sm'
                                            onMouseEnter={(e) => {
                                                setTooltipContent(
                                                    `${col.label}\n${row.name}\n\nAction: ${cell.action}\n${formatBytes(cell.volume)} · ${cell.flowCount} flows${cell.isTerminal ? '\n⬤ Evaluation stopped here' : ''}`,
                                                );
                                                setTooltipPos({ x: e.clientX, y: e.clientY });
                                            }}
                                            onMouseLeave={() => setTooltipContent('')}
                                            style={{ cursor: 'default' }}
                                        >
                                            <Flex align='center' justify='center' gap={1}>
                                                <Box
                                                    w={cell.isTerminal ? '12px' : '8px'}
                                                    h={cell.isTerminal ? '12px' : '8px'}
                                                    borderRadius='full'
                                                    bg={cellColor}
                                                    border={cell.isTerminal ? '2px solid white' : undefined}
                                                />
                                            </Flex>
                                        </Td>
                                    );
                                })}

                                {/* Outcome cell */}
                                <Td
                                    px={3} py={2}
                                    textAlign='center'
                                    bg={outcomeBg}
                                    borderLeft='1px solid'
                                    borderLeftColor='gray.700'
                                >
                                    <Text
                                        fontSize='xs' fontFamily='monospace'
                                        fontWeight='bold' color={outcomeColor}
                                    >
                                        {outcome}
                                    </Text>
                                </Td>
                            </Tr>
                        );
                    })}
                </Tbody>
            </Table>

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
        </Box>
    );
};

export default PolicyMatrix;
