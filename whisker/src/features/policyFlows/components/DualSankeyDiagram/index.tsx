import React from 'react';
import {
    buildDualSankey,
    Connection,
    LogicalFlow,
} from '../../utils/buildDualSankey';
import { Policy } from '@/types/api';
import { FlowLog } from '@/types/render';
import { Box, Flex, Text, Table, Tbody, Tr, Td } from '@chakra-ui/react';

type Props = {
    flows: FlowLog[];
    width?: number;
    height?: number;
    metric?: 'bytes' | 'packets';
    showPending?: boolean;
    onFlowSelect?: (sn: string, sns: string, dn: string, dns: string) => void;
};

const ACTION_COLORS: Record<string, string> = {
    Allow: '#38A169',
    'Default Allow': '#68D391',
    Deny: '#E53E3E',
    'Default Deny': '#FC8181',
    Pass: '#3182CE',
    Log: '#D69E2E',
};

const TIER_COLOR = '#4A5568';
const POLICY_COLOR = '#2B6CB0';

const formatValue = (value: number, metric: string) => {
    if (metric === 'bytes') {
        if (value < 1024) return `${value} B`;
        if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
        return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    }
    return `${value.toLocaleString()} pkts`;
};

// ── Layout constants ────────────────────────────────────────────────

const CONN_H = 38;         // Height per flow sub-band within a connection
const CONN_GAP = 6;        // Gap between sub-bands in a connection
const CONN_MARGIN = 22;    // Gap between connections
const TIER_W = 22;
const DOT_R = 7;
const TOP_MARGIN = 48;

// ── Helpers ─────────────────────────────────────────────────────────

const cleanName = (name: string) =>
    name.replace(/-[a-z0-9]{6,10}-\*$/, '-*');

const getOrderedTiers = (
    connections: Connection[],
    side: 'egress' | 'ingress',
): string[] => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const conn of connections) {
        for (const lf of conn.flows) {
            const pols = side === 'egress' ? lf.egressPolicies : lf.ingressPolicies;
            for (const p of pols) {
                const t = p.tier || '_profile_';
                if (t !== '_profile_' && !seen.has(t)) {
                    seen.add(t);
                    result.push(t);
                }
            }
        }
    }
    return result;
};

const getAction = (pols: Policy[], flowAction: string): string => {
    if (pols.length === 0) return flowAction;
    const last = pols[pols.length - 1];
    if (last.trigger) {
        return last.action === 'Deny' ? 'Default Deny' : last.action;
    }
    if (last.kind === 'Profile' && last.name?.startsWith('kns.')) return 'Default Allow';
    return last.action;
};

const curvedLink = (x1: number, y1: number, x2: number, y2: number) => {
    const dx = Math.abs(x2 - x1);
    const cp = Math.min(dx * 0.4, 30);
    return `M${x1},${y1} C${x1 + cp},${y1} ${x2 - cp},${y2} ${x2},${y2}`;
};

// ── Layout engine ───────────────────────────────────────────────────

type Band = {
    flowId: string;
    action: string;
    volume: number;
    y: number; // center Y of this sub-band
    egressPols: Policy[];
    ingressPols: Policy[];
    lf: LogicalFlow;
};

type ConnLayout = {
    conn: Connection;
    y: number; // top Y of the connection block
    h: number; // total height
    srcLabelY: number;
    dstLabelY: number;
    bands: Band[];
};

type TierBar = {
    tier: string;
    side: 'egress' | 'ingress';
    x: number;
    y: number;
    h: number;
};

type FullLayout = {
    conns: ConnLayout[];
    egressTierBars: TierBar[];
    ingressTierBars: TierBar[];
    totalHeight: number;
    // Column X positions
    srcX: number;
    egressTierXs: Map<string, { tierX: number; polX: number }>;
    egressActionX: number;
    ingressTierXs: Map<string, { tierX: number; polX: number }>;
    ingressActionX: number;
    dstX: number;
};

const buildLayout = (connections: Connection[], width: number): FullLayout => {
    const eTiers = getOrderedTiers(connections, 'egress');
    const iTiers = getOrderedTiers(connections, 'ingress');

    // X positions
    const srcX = 12;
    const eStart = 180;
    const eActX = width / 2 - 80;
    const iStart = width / 2 + 40;
    const iActX = width - 220;
    const dstX = width - 12;

    const eSlot = eTiers.length > 0 ? (eActX - eStart - 30) / eTiers.length : 0;
    const eTierXs = new Map<string, { tierX: number; polX: number }>();
    eTiers.forEach((t, i) =>
        eTierXs.set(t, { tierX: eStart + i * eSlot, polX: eStart + i * eSlot + TIER_W + 4 }),
    );

    const iSlot = iTiers.length > 0 ? (iActX - iStart - 30) / iTiers.length : 0;
    const iTierXs = new Map<string, { tierX: number; polX: number }>();
    iTiers.forEach((t, i) =>
        iTierXs.set(t, { tierX: iStart + i * iSlot, polX: iStart + i * iSlot + TIER_W + 4 }),
    );

    // Per-tier Y extents for bar spanning
    const eTierYs = new Map<string, { min: number; max: number }>();
    const iTierYs = new Map<string, { min: number; max: number }>();

    let curY = TOP_MARGIN;
    const conns: ConnLayout[] = [];

    for (const conn of connections) {
        const nFlows = conn.flows.length;
        const blockH = nFlows * CONN_H + (nFlows - 1) * CONN_GAP;
        const bands: Band[] = [];

        conn.flows.forEach((lf, fi) => {
            const bandY = curY + fi * (CONN_H + CONN_GAP) + CONN_H / 2;
            bands.push({
                flowId: lf.id,
                action: lf.action,
                volume: lf.volume,
                y: bandY,
                egressPols: [...lf.egressPolicies].sort((a, b) => (a.policy_index ?? 0) - (b.policy_index ?? 0)),
                ingressPols: [...lf.ingressPolicies].sort((a, b) => (a.policy_index ?? 0) - (b.policy_index ?? 0)),
                lf,
            });

            // Track tier Y extents
            for (const p of lf.egressPolicies) {
                const t = p.tier || '_profile_';
                if (t === '_profile_' || p.trigger || (p.kind === 'Profile' && p.name?.startsWith('kns.'))) continue;
                const ext = eTierYs.get(t) || { min: bandY - CONN_H / 2, max: bandY + CONN_H / 2 };
                ext.min = Math.min(ext.min, bandY - CONN_H / 2);
                ext.max = Math.max(ext.max, bandY + CONN_H / 2);
                eTierYs.set(t, ext);
            }
            for (const p of lf.ingressPolicies) {
                const t = p.tier || '_profile_';
                if (t === '_profile_' || p.trigger || (p.kind === 'Profile' && p.name?.startsWith('kns.'))) continue;
                const ext = iTierYs.get(t) || { min: bandY - CONN_H / 2, max: bandY + CONN_H / 2 };
                ext.min = Math.min(ext.min, bandY - CONN_H / 2);
                ext.max = Math.max(ext.max, bandY + CONN_H / 2);
                iTierYs.set(t, ext);
            }
        });

        conns.push({
            conn,
            y: curY,
            h: blockH,
            srcLabelY: curY + blockH / 2,
            dstLabelY: curY + blockH / 2,
            bands,
        });

        curY += blockH + CONN_MARGIN;
    }

    // Tier bars
    const eTierBars: TierBar[] = eTiers.map((t) => {
        const c = eTierXs.get(t)!;
        const ext = eTierYs.get(t) || { min: TOP_MARGIN, max: curY };
        return { tier: t, side: 'egress', x: c.tierX, y: ext.min - 2, h: ext.max - ext.min + 4 };
    });
    const iTierBars: TierBar[] = iTiers.map((t) => {
        const c = iTierXs.get(t)!;
        const ext = iTierYs.get(t) || { min: TOP_MARGIN, max: curY };
        return { tier: t, side: 'ingress', x: c.tierX, y: ext.min - 2, h: ext.max - ext.min + 4 };
    });

    return {
        conns,
        egressTierBars: eTierBars,
        ingressTierBars: iTierBars,
        totalHeight: curY + 10,
        srcX,
        egressTierXs: eTierXs,
        egressActionX: eActX,
        ingressTierXs: iTierXs,
        ingressActionX: iActX,
        dstX,
    };
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
    const [hoveredConn, setHoveredConn] = React.useState<string | null>(null);
    const [tooltipContent, setTooltipContent] = React.useState('');
    const [tooltipPos, setTooltipPos] = React.useState({ x: 0, y: 0 });

    const dual = React.useMemo(
        () => buildDualSankey(flows || [], metric, showPending),
        [flows, metric, showPending],
    );

    const lo = React.useMemo(
        () => buildLayout(dual.connections, width),
        [dual, width],
    );

    const effectiveHeight = Math.max(height, lo.totalHeight);
    const maxVol = React.useMemo(
        () => Math.max(...dual.logicalFlows.map((f) => f.volume), 1),
        [dual],
    );

    const activeConn = hoveredConn || (selectedFlow
        ? dual.connections.find((c) => c.flows.some((f) => f.id === selectedFlow))?.id || null
        : null);

    const selectedLF = dual.logicalFlows.find((f) => f.id === selectedFlow);

    if (dual.connections.length === 0) {
        return (
            <Flex align='center' justify='center' h={height} color='gray.500'>
                <Text>No policy trace data available.</Text>
            </Flex>
        );
    }

    const isActive = (connId: string) => activeConn === null || activeConn === connId;
    const isBandActive = (flowId: string) => selectedFlow === null || selectedFlow === flowId;
    const trans = { transition: 'opacity 0.15s ease' };

    return (
        <Box>
            <Box position='relative' overflowY='auto' maxH='calc(100vh - 250px)' mx='auto'>
                <svg width={width} height={effectiveHeight}>
                    {/* Column headers */}
                    <text x={lo.srcX} y={22} fontSize={12} fill='#718096' fontWeight='bold' fontFamily='monospace'>SOURCE</text>
                    <text x={180} y={22} fontSize={12} fill='#718096' fontWeight='bold' fontFamily='monospace'>EGRESS POLICIES</text>
                    <text x={lo.egressActionX} y={22} fontSize={12} fill='#718096' fontWeight='bold' fontFamily='monospace'>ACTION</text>
                    <text x={width / 2 + 40} y={22} fontSize={12} fill='#718096' fontWeight='bold' fontFamily='monospace'>INGRESS POLICIES</text>
                    <text x={lo.ingressActionX} y={22} fontSize={12} fill='#718096' fontWeight='bold' fontFamily='monospace'>ACTION</text>
                    <text x={lo.dstX} y={22} fontSize={12} fill='#718096' fontWeight='bold' textAnchor='end' fontFamily='monospace'>DEST</text>
                    <line x1={0} y1={34} x2={width} y2={34} stroke='#2D3748' strokeWidth={0.5} />
                    {/* Center divider */}
                    <line x1={width / 2 - 18} y1={38} x2={width / 2 - 18} y2={effectiveHeight} stroke='#2D3748' strokeDasharray='2,4' />

                    {/* Tier bars with rotated labels inside */}
                    {[...lo.egressTierBars, ...lo.ingressTierBars].map((tb) => {
                        const cx = tb.x + TIER_W / 2;
                        const cy = tb.y + tb.h / 2;
                        return (
                            <g key={`tb-${tb.side}-${tb.tier}`}>
                                <rect
                                    x={tb.x} y={tb.y} width={TIER_W} height={tb.h}
                                    fill={TIER_COLOR} stroke='#718096' strokeWidth={0.5} rx={3}
                                    opacity={0.8}
                                />
                                <text
                                    x={cx} y={cy}
                                    textAnchor='middle'
                                    dominantBaseline='central'
                                    transform={`rotate(-90, ${cx}, ${cy})`}
                                    fontSize={12}
                                    fontWeight='bold'
                                    fill='#CBD5E0'
                                    fontFamily='monospace'
                                    letterSpacing='0.5px'
                                >
                                    {tb.tier.toUpperCase()}
                                </text>
                            </g>
                        );
                    })}

                    {/* Connections */}
                    {lo.conns.map((cl) => {
                        const active = isActive(cl.conn.id);
                        return (
                            <g key={cl.conn.id} opacity={active ? 1 : 0.12} style={trans}>
                                {/* Connection background */}
                                <rect
                                    x={lo.srcX}
                                    y={cl.y - 2}
                                    width={width - lo.srcX * 2}
                                    height={cl.h + 4}
                                    fill='transparent'
                                    onMouseEnter={() => setHoveredConn(cl.conn.id)}
                                    onMouseLeave={() => setHoveredConn(null)}
                                />

                                {/* Source label */}
                                <text
                                    x={lo.srcX} y={cl.srcLabelY} dy='0.35em'
                                    fontSize={13} fill='#E2E8F0' fontFamily='monospace' fontWeight='600'
                                    style={{ cursor: 'pointer' }}
                                    onClick={() => setSelectedFlow(null)}
                                    onMouseEnter={() => setHoveredConn(cl.conn.id)}
                                    onMouseLeave={() => setHoveredConn(null)}
                                >
                                    {cleanName(cl.conn.sourceName)}
                                </text>
                                {cl.conn.flows.length > 1 && (
                                    <text
                                        x={lo.srcX} y={cl.srcLabelY + 12} fontSize={11} fill='#718096' fontFamily='monospace'
                                    >
                                        {cl.conn.sourceNamespace}
                                    </text>
                                )}

                                {/* Dest label */}
                                <text
                                    x={lo.dstX} y={cl.dstLabelY} dy='0.35em'
                                    textAnchor='end'
                                    fontSize={13} fill='#E2E8F0' fontFamily='monospace' fontWeight='600'
                                >
                                    {cleanName(cl.conn.destName)}
                                </text>
                                {cl.conn.flows.length > 1 && (
                                    <text
                                        x={lo.dstX} y={cl.dstLabelY + 12}
                                        textAnchor='end' fontSize={11} fill='#718096' fontFamily='monospace'
                                    >
                                        {cl.conn.destNamespace}
                                    </text>
                                )}

                                {/* Flow bands */}
                                {cl.bands.map((band) => {
                                    const bandActive = isBandActive(band.flowId);
                                    const color = ACTION_COLORS[band.action] || '#718096';
                                    const w = 2 + (band.volume / maxVol) * 4;

                                    // Build link segments for egress side
                                    const eSegs: { x1: number; x2: number }[] = [];
                                    let ex = egressStart(lo);
                                    for (const p of band.egressPols) {
                                        const t = p.tier || '_profile_';
                                        if (t === '_profile_' || p.trigger || (p.kind === 'Profile' && p.name?.startsWith('kns.'))) continue;
                                        const c = lo.egressTierXs.get(t);
                                        if (!c) continue;
                                        eSegs.push({ x1: ex, x2: c.polX });
                                        ex = c.polX + DOT_R * 2 + 2;
                                    }
                                    eSegs.push({ x1: ex, x2: lo.egressActionX });

                                    // Ingress side
                                    const iSegs: { x1: number; x2: number }[] = [];
                                    let ix = ingressStart(lo);
                                    for (const p of band.ingressPols) {
                                        const t = p.tier || '_profile_';
                                        if (t === '_profile_' || p.trigger || (p.kind === 'Profile' && p.name?.startsWith('kns.'))) continue;
                                        const c = lo.ingressTierXs.get(t);
                                        if (!c) continue;
                                        iSegs.push({ x1: ix, x2: c.polX });
                                        ix = c.polX + DOT_R * 2 + 2;
                                    }
                                    iSegs.push({ x1: ix, x2: lo.ingressActionX });

                                    const eAct = getAction(band.egressPols, band.action);
                                    const iAct = getAction(band.ingressPols, band.action);
                                    const eActColor = ACTION_COLORS[eAct] || '#718096';
                                    const iActColor = ACTION_COLORS[iAct] || '#718096';

                                    // If egress denies, traffic never reaches ingress
                                    const egressDenied = eAct === 'Deny' || eAct === 'Default Deny';
                                    // Ingress side is grayed out if egress denied
                                    const ingressDimmed = egressDenied;
                                    const ingressOpacity = ingressDimmed ? 0.12 : 0.6;
                                    const ingressDotOpacity = ingressDimmed ? 0.12 : 1;

                                    return (
                                        <g
                                            key={band.flowId}
                                            opacity={bandActive ? 1 : 0.25}
                                            style={{ ...trans, cursor: 'pointer' }}
                                            onClick={() => setSelectedFlow(
                                                selectedFlow === band.flowId ? null : band.flowId,
                                            )}
                                        >
                                            {/* Egress flow lines */}
                                            {eSegs.map((s, si) => (
                                                <path
                                                    key={`e-${si}`}
                                                    d={curvedLink(s.x1, band.y, s.x2, band.y)}
                                                    fill='none' stroke={color}
                                                    strokeWidth={w} strokeOpacity={0.6}
                                                    strokeLinecap='round'
                                                />
                                            ))}

                                            {/* Bridge: only show if egress didn't deny */}
                                            {!egressDenied && (
                                                <path
                                                    d={curvedLink(lo.egressActionX + DOT_R * 2 + 2, band.y, ingressStart(lo) - 4, band.y)}
                                                    fill='none' stroke={color}
                                                    strokeWidth={w * 0.7} strokeOpacity={0.3}
                                                    strokeDasharray='3,3' strokeLinecap='round'
                                                />
                                            )}

                                            {/* Ingress flow lines: dimmed if egress denied */}
                                            {iSegs.map((s, si) => (
                                                <path
                                                    key={`i-${si}`}
                                                    d={curvedLink(s.x1, band.y, s.x2, band.y)}
                                                    fill='none'
                                                    stroke={ingressDimmed ? '#2D3748' : color}
                                                    strokeWidth={ingressDimmed ? 1 : w}
                                                    strokeOpacity={ingressOpacity}
                                                    strokeLinecap='round'
                                                    strokeDasharray={ingressDimmed ? '2,3' : undefined}
                                                />
                                            ))}

                                            {/* Policy dots on egress */}
                                            {band.egressPols.map((p, pi) => {
                                                const t = p.tier || '_profile_';
                                                if (t === '_profile_' || p.trigger || (p.kind === 'Profile' && p.name?.startsWith('kns.'))) return null;
                                                const c = lo.egressTierXs.get(t);
                                                if (!c) return null;
                                                return (
                                                    <g key={`ed-${pi}`}
                                                        onMouseEnter={(e) => {
                                                            setTooltipContent(`${p.name} (${p.action})`);
                                                            setTooltipPos({ x: e.clientX, y: e.clientY });
                                                        }}
                                                        onMouseLeave={() => setTooltipContent('')}
                                                    >
                                                        <circle cx={c.polX + DOT_R} cy={band.y} r={DOT_R}
                                                            fill={ACTION_COLORS[p.action] || POLICY_COLOR}
                                                            stroke='rgba(255,255,255,0.3)' strokeWidth={1}
                                                        />
                                                    </g>
                                                );
                                            })}

                                            {/* Policy dots on ingress: dimmed if egress denied */}
                                            {band.ingressPols.map((p, pi) => {
                                                const t = p.tier || '_profile_';
                                                if (t === '_profile_' || p.trigger || (p.kind === 'Profile' && p.name?.startsWith('kns.'))) return null;
                                                const c = lo.ingressTierXs.get(t);
                                                if (!c) return null;
                                                return (
                                                    <g key={`id-${pi}`}
                                                        opacity={ingressDotOpacity}
                                                        onMouseEnter={(e) => {
                                                            setTooltipContent(`${p.name} (${p.action})`);
                                                            setTooltipPos({ x: e.clientX, y: e.clientY });
                                                        }}
                                                        onMouseLeave={() => setTooltipContent('')}
                                                    >
                                                        <circle cx={c.polX + DOT_R} cy={band.y} r={DOT_R}
                                                            fill={ingressDimmed ? '#2D3748' : (ACTION_COLORS[p.action] || POLICY_COLOR)}
                                                            stroke={ingressDimmed ? '#4A5568' : 'rgba(255,255,255,0.3)'}
                                                            strokeWidth={1}
                                                        />
                                                    </g>
                                                );
                                            })}

                                            {/* Egress action dot */}
                                            <circle cx={lo.egressActionX + DOT_R} cy={band.y} r={DOT_R + 1}
                                                fill={eActColor} stroke='rgba(255,255,255,0.4)' strokeWidth={1.5}
                                            />
                                            <text x={lo.egressActionX + DOT_R * 2 + 6} y={band.y} dy='0.35em'
                                                fontSize={11} fill={eActColor} fontFamily='monospace' fontWeight='bold'
                                            >
                                                {eAct}
                                            </text>

                                            {/* Ingress action dot: dimmed if egress denied */}
                                            <circle cx={lo.ingressActionX + DOT_R} cy={band.y} r={DOT_R + 1}
                                                fill={ingressDimmed ? '#2D3748' : iActColor}
                                                stroke={ingressDimmed ? '#4A5568' : 'rgba(255,255,255,0.4)'}
                                                strokeWidth={1.5}
                                                opacity={ingressDotOpacity}
                                            />
                                            {!ingressDimmed && (
                                                <text x={lo.ingressActionX + DOT_R * 2 + 6} y={band.y} dy='0.35em'
                                                    fontSize={11} fill={iActColor} fontFamily='monospace' fontWeight='bold'
                                                >
                                                    {iAct}
                                                </text>
                                            )}

                                            {/* Protocol/port label near center */}
                                            <text
                                                x={width / 2 - 18} y={band.y} dy='0.35em'
                                                textAnchor='middle'
                                                fontSize={10} fill='#4A5568' fontFamily='monospace'
                                            >
                                                {band.lf.protocol}:{band.lf.destPort}
                                            </text>
                                        </g>
                                    );
                                })}
                            </g>
                        );
                    })}
                </svg>

                {tooltipContent && (
                    <Box
                        position='fixed' left={tooltipPos.x + 14} top={tooltipPos.y - 24}
                        bg='gray.900' color='white' px={3} py={1.5}
                        borderRadius='lg' fontSize='xs' fontFamily='monospace'
                        pointerEvents='none' zIndex={1000} whiteSpace='nowrap'
                        border='1px solid' borderColor='gray.600' boxShadow='lg'
                    >
                        {tooltipContent}
                    </Box>
                )}
            </Box>

            {/* Detail panel */}
            {selectedLF && (
                <Box bg='gray.800' borderRadius='lg' border='1px solid' borderColor='gray.600' mt={3} p={4} mx='auto'>
                    <Flex justify='space-between' align='center' mb={3}>
                        <Box>
                            <Text color='white' fontWeight='bold' fontSize='sm' fontFamily='monospace'>
                                {selectedLF.sourceNamespace}/{selectedLF.sourceName} → {selectedLF.destNamespace}/{selectedLF.destName}
                            </Text>
                            <Flex gap={4} mt={1} fontSize='xs' color='gray.400' fontFamily='monospace'>
                                <Text>{selectedLF.protocol}:{selectedLF.destPort}</Text>
                                <Text>{formatValue(selectedLF.volume, metric)}</Text>
                                <Text color={ACTION_COLORS[selectedLF.action] || 'gray.400'} fontWeight='bold'>
                                    {selectedLF.action}
                                </Text>
                            </Flex>
                        </Box>
                        <Flex gap={3} align='center'>
                            {onFlowSelect && (
                                <Text color='blue.300' fontSize='xs' cursor='pointer' fontFamily='monospace'
                                    onClick={() => onFlowSelect(selectedLF.sourceName, selectedLF.sourceNamespace, selectedLF.destName, selectedLF.destNamespace)}
                                    _hover={{ color: 'blue.200' }}
                                >
                                    Topology →
                                </Text>
                            )}
                            <Text color='gray.500' fontSize='xs' cursor='pointer' onClick={() => setSelectedFlow(null)} _hover={{ color: 'white' }}>✕</Text>
                        </Flex>
                    </Flex>
                    <Flex gap={8}>
                        <PolicyTable label='EGRESS' policies={selectedLF.egressPolicies} />
                        <PolicyTable label='INGRESS' policies={selectedLF.ingressPolicies} />
                    </Flex>
                </Box>
            )}
        </Box>
    );
};

// Helper functions for X positions
const egressStart = (lo: { egressTierXs: Map<string, unknown>; egressActionX: number }) => {
    const firstTier = [...lo.egressTierXs.keys()][0];
    if (!firstTier) return lo.egressActionX - 20;
    return 175;
};

const ingressStart = (lo: { ingressTierXs: Map<string, unknown> }) => {
    const firstTier = [...lo.ingressTierXs.keys()][0];
    if (!firstTier) return 0;
    return (lo.ingressTierXs as Map<string, { tierX: number }>).get(firstTier)!.tierX - 10;
};

const PolicyTable: React.FC<{ label: string; policies: Policy[] }> = ({ label, policies }) => (
    <Box flex={1}>
        <Text fontSize='xs' color='gray.500' fontWeight='bold' mb={2} fontFamily='monospace'>{label}</Text>
        {policies.length > 0 ? (
            <Table size='sm' variant='unstyled'>
                <Tbody>
                    {policies.map((p, i) => {
                        const isKnsProfile = p.kind === 'Profile' && p.name.startsWith('kns.');
                        const isEndOfTier = !!p.trigger;
                        const displayTier = isKnsProfile ? '' : (p.tier || 'profile');
                        const displayName = isKnsProfile
                            ? 'Default Allow'
                            : isEndOfTier
                              ? `End of Tier ${p.tier || 'default'}`
                              : p.name;
                        const displayAction = isKnsProfile
                            ? 'Allow'
                            : isEndOfTier && p.action === 'Deny'
                              ? 'Default Deny'
                              : p.action;
                        const actionColor = isKnsProfile
                            ? ACTION_COLORS['Default Allow']
                            : isEndOfTier && p.action === 'Deny'
                              ? ACTION_COLORS['Default Deny']
                              : ACTION_COLORS[p.action];
                        return (
                            <Tr key={i}>
                                <Td color='gray.500' fontSize='xs' px={1} py={0.5} fontFamily='monospace'>{displayTier}</Td>
                                <Td color={isKnsProfile ? 'gray.500' : 'gray.300'} fontSize='xs' px={1} py={0.5} fontFamily='monospace' fontStyle={isKnsProfile ? 'italic' : undefined}>{displayName}</Td>
                                <Td fontSize='xs' px={1} py={0.5} fontFamily='monospace'>
                                    <Text color={actionColor || 'gray.400'} fontWeight='bold'>{displayAction}</Text>
                                </Td>
                            </Tr>
                        );
                    })}
                </Tbody>
            </Table>
        ) : (
            <Text color='gray.600' fontSize='xs' fontFamily='monospace'>—</Text>
        )}
    </Box>
);

export default DualSankeyDiagram;
