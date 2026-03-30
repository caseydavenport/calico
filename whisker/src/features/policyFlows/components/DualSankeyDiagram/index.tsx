import React from 'react';
import {
    buildDualSankey,
    Connection,
    LogicalFlow,
} from '../../utils/buildDualSankey';
import { Policy } from '@/types/api';
import { FlowLog } from '@/types/render';
import { Box, Flex, Text, Table, Tbody, Tr, Td } from '@chakra-ui/react';
import { AnimatePresence, motion } from 'framer-motion';

const MotionBox = motion(Box);

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
const DOT_R = 9;
const TOP_MARGIN = 48;
const ACTION_BADGE_MAX_W = 110; // right-alignment zone width for action badges

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
    // Always show the "default" tier at the end (Profile evaluation)
    if (!seen.has('default')) {
        result.push('default');
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
    networkLeft: number;
    networkRight: number;
    ingressTierXs: Map<string, { tierX: number; polX: number }>;
    ingressActionX: number;
    dstX: number;
};

const buildLayout = (connections: Connection[], width: number): FullLayout => {
    const eTiers = getOrderedTiers(connections, 'egress');
    const iTiers = getOrderedTiers(connections, 'ingress');

    // X positions — center gap is the "network" zone (60px wide)
    const srcX = 12;
    const eStart = 180;
    const networkLeft = width / 2 - 30;
    const networkRight = width / 2 + 30;
    const eActX = networkLeft - ACTION_BADGE_MAX_W - 10;
    const iStart = networkRight + 10;
    const iActX = width - 240;
    const dstX = width - 12;

    const eSlot = eTiers.length > 0 ? (eActX - eStart - 30) / eTiers.length : 0;
    const eTierXs = new Map<string, { tierX: number; polX: number }>();
    eTiers.forEach((t, i) => {
        const tierRight = eStart + i * eSlot + TIER_W;
        const nextTierLeft = i < eTiers.length - 1
            ? eStart + (i + 1) * eSlot
            : eActX;
        const polCenter = tierRight + (nextTierLeft - tierRight) / 2;
        eTierXs.set(t, { tierX: eStart + i * eSlot, polX: polCenter - DOT_R });
    });

    const iSlot = iTiers.length > 0 ? (iActX - iStart - 30) / iTiers.length : 0;
    const iTierXs = new Map<string, { tierX: number; polX: number }>();
    iTiers.forEach((t, i) => {
        const tierRight = iStart + i * iSlot + TIER_W;
        const nextTierLeft = i < iTiers.length - 1
            ? iStart + (i + 1) * iSlot
            : iActX;
        const polCenter = tierRight + (nextTierLeft - tierRight) / 2;
        iTierXs.set(t, { tierX: iStart + i * iSlot, polX: polCenter - DOT_R });
    });

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

    // Tier bars — all span the full chart height for visual consistency
    const fullTop = TOP_MARGIN;
    const fullBottom = curY;
    const fullH = Math.max(fullBottom - fullTop, 20);
    const eTierBars: TierBar[] = eTiers.map((t) => {
        const c = eTierXs.get(t)!;
        return { tier: t, side: 'egress', x: c.tierX, y: fullTop, h: fullH };
    });
    const iTierBars: TierBar[] = iTiers.map((t) => {
        const c = iTierXs.get(t)!;
        return { tier: t, side: 'ingress', x: c.tierX, y: fullTop, h: fullH };
    });

    return {
        conns,
        egressTierBars: eTierBars,
        ingressTierBars: iTierBars,
        totalHeight: curY + 10,
        srcX,
        egressTierXs: eTierXs,
        egressActionX: eActX,
        networkLeft,
        networkRight,
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
        <Box position='relative' overflow='hidden'>
            <Box overflowY='auto' h='100%' mx='auto'>
                <svg width={width} height={effectiveHeight}>
                    {/* Column headers */}
                    <text x={lo.srcX} y={22} fontSize={12} fill='#718096' fontWeight='bold' fontFamily='monospace'>SOURCE</text>
                    <text x={180} y={22} fontSize={12} fill='#718096' fontWeight='bold' fontFamily='monospace'>EGRESS POLICIES</text>
                    <text x={lo.egressActionX} y={22} fontSize={12} fill='#718096' fontWeight='bold' fontFamily='monospace'>ACTION</text>
                    <text x={lo.networkRight + 15} y={22} fontSize={12} fill='#718096' fontWeight='bold' fontFamily='monospace'>INGRESS POLICIES</text>
                    <text x={lo.ingressActionX} y={22} fontSize={12} fill='#718096' fontWeight='bold' fontFamily='monospace'>ACTION</text>
                    <text x={lo.dstX} y={22} fontSize={12} fill='#718096' fontWeight='bold' textAnchor='end' fontFamily='monospace'>DEST</text>
                    <line x1={0} y1={34} x2={width} y2={34} stroke='#2D3748' strokeWidth={0.5} />

                    {/* Network zone — the gap between egress and ingress */}
                    <defs>
                        <pattern id='network-pattern' patternUnits='userSpaceOnUse' width='8' height='8'>
                            <path d='M0,8 L8,0' stroke='#2D3748' strokeWidth={0.5} />
                        </pattern>
                    </defs>
                    <rect
                        x={lo.networkLeft} y={TOP_MARGIN - 4}
                        width={lo.networkRight - lo.networkLeft}
                        height={effectiveHeight - TOP_MARGIN + 4}
                        fill='url(#network-pattern)'
                        opacity={0.5}
                    />
                    <line x1={lo.networkLeft} y1={TOP_MARGIN - 4} x2={lo.networkLeft} y2={effectiveHeight} stroke='#2D3748' strokeWidth={1} />
                    <line x1={lo.networkRight} y1={TOP_MARGIN - 4} x2={lo.networkRight} y2={effectiveHeight} stroke='#2D3748' strokeWidth={1} />
                    <text
                        x={width / 2} y={TOP_MARGIN + 6}
                        textAnchor='middle'
                        fontSize={9} fill='#4A5568' fontFamily='monospace'
                        letterSpacing='2px'
                    >
                        NETWORK
                    </text>

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
                                    // Use log scale so small flows are still visible
                                    // but high-volume flows are noticeably thicker.
                                    const logVol = Math.log(band.volume + 1);
                                    const logMax = Math.log(maxVol + 1);
                                    const w = 3 + (logVol / logMax) * 11;

                                    const srcExternal = band.lf.sourceName === 'PRIVATE NETWORK' || band.lf.sourceNamespace === '-';
                                    const dstExternal = band.lf.destName === 'PRIVATE NETWORK' || band.lf.destNamespace === '-';

                                    // Compute actions first (needed for badge sizing)
                                    const eAct = getAction(band.egressPols, band.action);
                                    const iAct = getAction(band.ingressPols, band.action);
                                    const eActColor = ACTION_COLORS[eAct] || '#718096';
                                    const iActColor = ACTION_COLORS[iAct] || '#718096';
                                    const eBadgeW = eAct.length * 7.5 + 14;
                                    const iBadgeW = iAct.length * 7.5 + 14;
                                    const eBadgeLeft = lo.egressActionX + ACTION_BADGE_MAX_W - eBadgeW;
                                    const iBadgeLeft = lo.ingressActionX + ACTION_BADGE_MAX_W - iBadgeW;

                                    // Build egress segments.
                                    // - Explicit deny: stop at the denying policy dot
                                    // - Default deny (trigger): continue through the policy to the next tier bar
                                    // - Allow/Pass: continue to the action badge
                                    const eSegs: { x1: number; x2: number }[] = [];
                                    type VisiblePol = Policy & { isTrigger?: boolean };
                                    const eVisiblePols: VisiblePol[] = [];
                                    if (!srcExternal) {
                                        let ex = egressStart(lo);
                                        let terminated = false;
                                        for (let pi = 0; pi < band.egressPols.length; pi++) {
                                            const p = band.egressPols[pi];
                                            const t = p.tier || '_profile_';
                                            if (t === '_profile_' || (p.kind === 'Profile' && p.name?.startsWith('kns.'))) continue;

                                            if (p.trigger) {
                                                // Add the trigger policy as a gray dot
                                                const trigger = p.trigger as Policy;
                                                const c = lo.egressTierXs.get(trigger.tier || t);
                                                if (c) {
                                                    eSegs.push({ x1: ex, x2: c.polX });
                                                    ex = c.polX + DOT_R * 2 + 2;
                                                    eVisiblePols.push({ ...trigger, isTrigger: true });
                                                }
                                                // Extend line to the NEXT tier bar's left edge
                                                const eTiers = [...lo.egressTierXs.keys()];
                                                const tierIdx = eTiers.indexOf(t);
                                                const nextTier = tierIdx >= 0 && tierIdx < eTiers.length - 1
                                                    ? lo.egressTierXs.get(eTiers[tierIdx + 1])
                                                    : null;
                                                if (nextTier) {
                                                    eSegs.push({ x1: ex, x2: nextTier.tierX });
                                                } else {
                                                    // Last tier — extend to action badge zone
                                                    eSegs.push({ x1: ex, x2: eBadgeLeft - 4 });
                                                }
                                                terminated = true;
                                                break;
                                            }

                                            const c = lo.egressTierXs.get(t);
                                            if (!c) continue;
                                            eSegs.push({ x1: ex, x2: c.polX });
                                            ex = c.polX + DOT_R * 2 + 2;
                                            eVisiblePols.push(p);

                                            if (p.action === 'Deny') {
                                                terminated = true;
                                                break;
                                            }
                                        }
                                        if (!terminated) {
                                            eSegs.push({ x1: ex, x2: eBadgeLeft - 4 });
                                        }
                                    }

                                    // Build ingress segments — same logic
                                    const iSegs: { x1: number; x2: number }[] = [];
                                    const iVisiblePols: VisiblePol[] = [];
                                    if (!dstExternal) {
                                        let ix = ingressStart(lo);
                                        let terminated = false;
                                        for (let pi = 0; pi < band.ingressPols.length; pi++) {
                                            const p = band.ingressPols[pi];
                                            const t = p.tier || '_profile_';
                                            if (t === '_profile_' || (p.kind === 'Profile' && p.name?.startsWith('kns.'))) continue;

                                            if (p.trigger) {
                                                const trigger = p.trigger as Policy;
                                                const trigC = lo.ingressTierXs.get(trigger.tier || t);
                                                if (trigC) {
                                                    iSegs.push({ x1: ix, x2: trigC.polX });
                                                    ix = trigC.polX + DOT_R * 2 + 2;
                                                    iVisiblePols.push({ ...trigger, isTrigger: true });
                                                }
                                                // Extend to the NEXT tier bar's left edge
                                                const iTiers = [...lo.ingressTierXs.keys()];
                                                const tierIdx = iTiers.indexOf(t);
                                                const nextTier = tierIdx >= 0 && tierIdx < iTiers.length - 1
                                                    ? lo.ingressTierXs.get(iTiers[tierIdx + 1])
                                                    : null;
                                                if (nextTier) {
                                                    iSegs.push({ x1: ix, x2: nextTier.tierX });
                                                } else {
                                                    iSegs.push({ x1: ix, x2: iBadgeLeft - 4 });
                                                }
                                                terminated = true;
                                                break;
                                            }

                                            const c = lo.ingressTierXs.get(t);
                                            if (!c) continue;
                                            iSegs.push({ x1: ix, x2: c.polX });
                                            ix = c.polX + DOT_R * 2 + 2;
                                            iVisiblePols.push(p);

                                            if (p.action === 'Deny') {
                                                terminated = true;
                                                break;
                                            }
                                        }
                                        if (!terminated) {
                                            iSegs.push({ x1: ix, x2: iBadgeLeft - 4 });
                                        }
                                    }

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
                                            {/* Invisible hit area spanning the full lane width for easy clicking */}
                                            <rect
                                                x={lo.srcX}
                                                y={band.y - CONN_H / 2}
                                                width={lo.dstX - lo.srcX}
                                                height={CONN_H}
                                                fill='transparent'
                                            />

                                            {/* Egress flow lines (hidden for external sources) */}
                                            {!srcExternal && eSegs.map((s, si) => (
                                                <path
                                                    key={`e-${si}`}
                                                    d={curvedLink(s.x1, band.y, s.x2, band.y)}
                                                    fill='none' stroke={color}
                                                    strokeWidth={w} strokeOpacity={0.6}
                                                    strokeLinecap='round'
                                                />
                                            ))}

                                            {/* Bridge across network zone: gray to show it's outside policy control */}
                                            {!egressDenied && !srcExternal && !dstExternal && (
                                                <path
                                                    d={curvedLink(eBadgeLeft + eBadgeW + 4, band.y, iBadgeLeft - 4, band.y)}
                                                    fill='none' stroke='#4A5568'
                                                    strokeWidth={w * 0.6} strokeOpacity={0.4}
                                                    strokeDasharray='4,3' strokeLinecap='round'
                                                />
                                            )}

                                            {/* Ingress flow lines: hidden for external dests, dimmed if egress denied */}
                                            {!dstExternal && iSegs.map((s, si) => (
                                                <path
                                                    key={`i-${si}`}
                                                    d={curvedLink(s.x1, band.y, s.x2, band.y)}
                                                    fill='none'
                                                    stroke={ingressDimmed ? '#2D3748' : color}
                                                    strokeWidth={ingressDimmed ? 2 : w}
                                                    strokeOpacity={ingressOpacity}
                                                    strokeLinecap='round'
                                                    strokeDasharray={ingressDimmed ? '2,3' : undefined}
                                                />
                                            ))}

                                            {/* Egress action badge — only for non-deny actions (denies are implicit from the line stopping) */}
                                            {!srcExternal && eAct !== 'Deny' && eAct !== 'Default Deny' && (() => {
                                                const badgeH = 18;
                                                const bx = eBadgeLeft;
                                                const by = band.y - badgeH / 2;
                                                return (
                                                    <g>
                                                        <rect
                                                            x={bx} y={by}
                                                            width={eBadgeW} height={badgeH}
                                                            rx={badgeH / 2}
                                                            fill={eActColor}
                                                            opacity={0.9}
                                                        />
                                                        <text
                                                            x={bx + eBadgeW / 2} y={band.y}
                                                            dy='0.35em'
                                                            textAnchor='middle'
                                                            fontSize={10}
                                                            fontWeight='bold'
                                                            fill='#1A202C'
                                                            fontFamily='monospace'
                                                        >
                                                            {eAct}
                                                        </text>
                                                    </g>
                                                );
                                            })()}

                                            {/* Ingress action badge — only for non-deny actions */}
                                            {!dstExternal && !ingressDimmed && iAct !== 'Deny' && iAct !== 'Default Deny' && (() => {
                                                const badgeH = 18;
                                                const bx = iBadgeLeft;
                                                const by = band.y - badgeH / 2;
                                                return (
                                                    <g>
                                                        <rect
                                                            x={bx} y={by}
                                                            width={iBadgeW} height={badgeH}
                                                            rx={badgeH / 2}
                                                            fill={iActColor}
                                                            opacity={0.9}
                                                        />
                                                        <text
                                                            x={bx + iBadgeW / 2} y={band.y}
                                                            dy='0.35em'
                                                            textAnchor='middle'
                                                            fontSize={10}
                                                            fontWeight='bold'
                                                            fill='#1A202C'
                                                            fontFamily='monospace'
                                                        >
                                                            {iAct}
                                                        </text>
                                                    </g>
                                                );
                                            })()}

                                            {/* Policy dots on egress — rendered on top of badges */}
                                            {!srcExternal && eVisiblePols.map((p, pi) => {
                                                const vp = p as VisiblePol;
                                                const t = p.tier || '_profile_';
                                                const c = lo.egressTierXs.get(t);
                                                if (!c) return null;
                                                const dotColor = vp.isTrigger ? '#718096' : (ACTION_COLORS[p.action] || POLICY_COLOR);
                                                const label = vp.isTrigger ? `${p.name} (triggered)` : `${p.name} (${p.action})`;
                                                return (
                                                    <g key={`ed-${pi}`}
                                                        onMouseEnter={(e) => {
                                                            setTooltipContent(label);
                                                            setTooltipPos({ x: e.clientX, y: e.clientY });
                                                        }}
                                                        onMouseLeave={() => setTooltipContent('')}
                                                    >
                                                        <circle cx={c.polX + DOT_R} cy={band.y} r={DOT_R}
                                                            fill={dotColor}
                                                            stroke='rgba(255,255,255,0.3)'
                                                            strokeWidth={1}
                                                        />
                                                    </g>
                                                );
                                            })}

                                            {/* Policy dots on ingress — rendered on top of badges */}
                                            {!dstExternal && iVisiblePols.map((p, pi) => {
                                                const vp = p as VisiblePol;
                                                const t = p.tier || '_profile_';
                                                const c = lo.ingressTierXs.get(t);
                                                if (!c) return null;
                                                const baseDotColor = vp.isTrigger ? '#718096' : (ACTION_COLORS[p.action] || POLICY_COLOR);
                                                const dotColor = ingressDimmed ? '#4A5568' : baseDotColor;
                                                const label = vp.isTrigger ? `${p.name} (triggered)` : `${p.name} (${p.action})`;
                                                return (
                                                    <g key={`id-${pi}`}
                                                        opacity={ingressDotOpacity}
                                                        onMouseEnter={(e) => {
                                                            setTooltipContent(label);
                                                            setTooltipPos({ x: e.clientX, y: e.clientY });
                                                        }}
                                                        onMouseLeave={() => setTooltipContent('')}
                                                    >
                                                        <circle cx={c.polX + DOT_R} cy={band.y} r={DOT_R}
                                                            fill={dotColor}
                                                            stroke={ingressDimmed ? '#4A5568' : 'rgba(255,255,255,0.3)'}
                                                            strokeWidth={1}
                                                        />
                                                    </g>
                                                );
                                            })}

                                            {/* Protocol/port label below the source label */}
                                            <text
                                                x={lo.srcX} y={band.y + 14}
                                                fontSize={9} fill='#4A5568' fontFamily='monospace'
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

            {/* Sliding detail panel overlay */}
            <AnimatePresence>
                {selectedLF && (
                    <MotionBox
                        position='absolute'
                        bottom={0}
                        left={0}
                        right={0}
                        bg='gray.800'
                        borderTop='1px solid'
                        borderColor='gray.600'
                        p={5}
                        initial={{ y: '100%' }}
                        animate={{ y: 0 }}
                        exit={{ y: '100%' }}
                        transition={{ type: 'spring', damping: 28, stiffness: 300 }}
                        boxShadow='0 -4px 20px rgba(0,0,0,0.4)'
                        zIndex={10}
                    >
                        <Flex justify='space-between' align='center' mb={3}>
                            <Box>
                                <Text color='white' fontWeight='bold' fontSize='md' fontFamily='monospace'>
                                    {selectedLF.sourceNamespace}/{selectedLF.sourceName}
                                    {'  →  '}
                                    {selectedLF.destNamespace}/{selectedLF.destName}
                                </Text>
                                <Flex gap={4} mt={1} fontSize='sm' color='gray.400' fontFamily='monospace'>
                                    <Text>{selectedLF.protocol}:{selectedLF.destPort}</Text>
                                    <Text>{formatValue(selectedLF.volume, metric)}</Text>
                                    <Text color={ACTION_COLORS[selectedLF.action] || 'gray.400'} fontWeight='bold'>
                                        {selectedLF.action}
                                    </Text>
                                </Flex>
                            </Box>
                            <Flex gap={4} align='center'>
                                {onFlowSelect && (
                                    <Text color='blue.300' fontSize='sm' cursor='pointer' fontFamily='monospace'
                                        onClick={() => onFlowSelect(selectedLF.sourceName, selectedLF.sourceNamespace, selectedLF.destName, selectedLF.destNamespace)}
                                        _hover={{ color: 'blue.200' }}
                                    >
                                        View in Topology →
                                    </Text>
                                )}
                                <Text
                                    color='gray.500' fontSize='sm' cursor='pointer'
                                    onClick={() => setSelectedFlow(null)}
                                    _hover={{ color: 'white' }}
                                    px={2}
                                >
                                    ✕
                                </Text>
                            </Flex>
                        </Flex>
                        <Flex gap={10}>
                            <PolicyTable label='EGRESS (source-side)' policies={selectedLF.egressPolicies} />
                            <PolicyTable label='INGRESS (dest-side)' policies={selectedLF.ingressPolicies} />
                        </Flex>
                    </MotionBox>
                )}
            </AnimatePresence>
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
                    {policies.flatMap((p, i) => {
                        const isKnsProfile = p.kind === 'Profile' && p.name.startsWith('kns.');
                        const isEndOfTier = !!p.trigger;

                        if (isKnsProfile) {
                            return [(
                                <Tr key={i}>
                                    <Td color='gray.500' fontSize='xs' px={1} py={0.5} fontFamily='monospace' />
                                    <Td color='gray.500' fontSize='xs' px={1} py={0.5} fontFamily='monospace' fontStyle='italic'>Default Allow</Td>
                                    <Td fontSize='xs' px={1} py={0.5} fontFamily='monospace'>
                                        <Text color={ACTION_COLORS['Default Allow']} fontWeight='bold'>Allow</Text>
                                    </Td>
                                </Tr>
                            )];
                        }

                        if (isEndOfTier) {
                            const trigger = p.trigger as Policy;
                            const tierName = p.tier || 'default';
                            const defaultAction = p.action === 'Deny' ? 'Default Deny' : p.action;
                            const defaultColor = p.action === 'Deny' ? ACTION_COLORS['Default Deny'] : ACTION_COLORS[p.action];
                            return [
                                // Row 1: the trigger policy with N/A action
                                <Tr key={`${i}-trigger`}>
                                    <Td color='gray.500' fontSize='xs' px={1} py={0.5} fontFamily='monospace'>{trigger.tier || tierName}</Td>
                                    <Td color='gray.300' fontSize='xs' px={1} py={0.5} fontFamily='monospace'>{trigger.name}</Td>
                                    <Td fontSize='xs' px={1} py={0.5} fontFamily='monospace'>
                                        <Text color='gray.500' fontWeight='bold'>N/A</Text>
                                    </Td>
                                </Tr>,
                                // Row 2: end-of-tier default action
                                <Tr key={`${i}-eot`}>
                                    <Td color='gray.500' fontSize='xs' px={1} py={0.5} fontFamily='monospace'>{tierName}</Td>
                                    <Td color='gray.400' fontSize='xs' px={1} py={0.5} fontFamily='monospace' fontStyle='italic'>End of Tier</Td>
                                    <Td fontSize='xs' px={1} py={0.5} fontFamily='monospace'>
                                        <Text color={defaultColor || 'gray.400'} fontWeight='bold'>{defaultAction}</Text>
                                    </Td>
                                </Tr>,
                            ];
                        }

                        // Regular policy
                        return [(
                            <Tr key={i}>
                                <Td color='gray.500' fontSize='xs' px={1} py={0.5} fontFamily='monospace'>{p.tier || 'profile'}</Td>
                                <Td color='gray.300' fontSize='xs' px={1} py={0.5} fontFamily='monospace'>{p.name}</Td>
                                <Td fontSize='xs' px={1} py={0.5} fontFamily='monospace'>
                                    <Text color={ACTION_COLORS[p.action] || 'gray.400'} fontWeight='bold'>{p.action}</Text>
                                </Td>
                            </Tr>
                        )];
                    })}
                </Tbody>
            </Table>
        ) : (
            <Text color='gray.600' fontSize='xs' fontFamily='monospace'>—</Text>
        )}
    </Box>
);

export default DualSankeyDiagram;
