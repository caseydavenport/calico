import React from 'react';
import ReactDOM from 'react-dom';
import { FlowLog } from '@/types/render';
import { Policy } from '@/types/api';
import { Box } from '@chakra-ui/react';

type Props = {
    srcFlow?: FlowLog;
    dstFlow?: FlowLog;
    width?: number;
};

const ACTION_COLORS: Record<string, string> = {
    Allow: '#38A169', 'Default Allow': '#68D391',
    Deny: '#E53E3E', 'Default Deny': '#FC8181',
    Pass: '#3182CE', 'N/A': '#718096',
};

const cleanName = (name: string) =>
    name.replace(/-[a-z0-9]{6,10}-\*$/, '-*');

const shortKind = (kind: string) => ({
    CalicoNetworkPolicy: 'CNP', GlobalNetworkPolicy: 'GNP',
    NetworkPolicy: 'KNP', Profile: 'Profile', StagedNetworkPolicy: 'Staged',
}[kind] || kind);

type Step = {
    label: string;
    fullLabel: string;
    action: string;
    tier: string;
    kind: string;
    namespace: string;
    isTerminal: boolean;
    isTrigger: boolean;
    isKnsProfile: boolean;
};

const normalizeSteps = (policies: Policy[]): Step[] => {
    const sorted = [...policies].sort((a, b) => (a.policy_index ?? 0) - (b.policy_index ?? 0));
    const steps: Step[] = [];
    for (const p of sorted) {
        if (p.kind === 'Profile' && p.name.startsWith('kns.')) {
            steps.push({ label: 'Default Allow', fullLabel: 'Default Allow (Profile)', action: 'Allow', tier: '_profile_', kind: 'Profile', namespace: '', isTerminal: true, isTrigger: false, isKnsProfile: true });
            break;
        }
        if (p.trigger) {
            const t = p.trigger as Policy;
            steps.push({ label: t.name, fullLabel: `${shortKind(t.kind)}: ${t.namespace ? t.namespace + '/' : ''}${t.name}`, action: 'N/A', tier: t.tier || 'default', kind: t.kind, namespace: t.namespace || '', isTerminal: false, isTrigger: true, isKnsProfile: false });
            const act = p.action === 'Deny' ? 'Default Deny' : p.action;
            steps.push({ label: `End of ${p.tier || 'default'}`, fullLabel: `End of Tier: ${p.tier || 'default'}`, action: act, tier: p.tier || 'default', kind: 'EndOfTier', namespace: '', isTerminal: true, isTrigger: false, isKnsProfile: false });
            break;
        }
        const isTerminal = p.action === 'Allow' || p.action === 'Deny';
        steps.push({ label: p.name, fullLabel: `${shortKind(p.kind)}: ${p.namespace ? p.namespace + '/' : ''}${p.name}`, action: p.action, tier: p.tier || 'default', kind: p.kind, namespace: p.namespace || '', isTerminal, isTrigger: false, isKnsProfile: false });
        if (p.action === 'Deny') break;
    }
    return steps;
};

const getOrderedTiers = (steps: Step[]): string[] => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const s of steps) {
        if (s.tier === '_profile_') continue;
        if (!seen.has(s.tier)) { seen.add(s.tier); result.push(s.tier); }
    }
    if (steps.some((s) => s.tier === '_profile_')) result.push('_profile_');
    return result;
};

const TIER_W = 24;
const DOT_R = 8;
const SVG_H = 44;

const FlowTraceViz: React.FC<Props> = ({ srcFlow, dstFlow, width = 900 }) => {
    const [tooltip, setTooltip] = React.useState<{ type: 'step'; step: Step; x: number; y: number } | { type: 'tier'; tier: string; side: string; x: number; y: number } | null>(null);

    const flow = srcFlow || dstFlow;
    if (!flow) return null;

    const egressSteps = srcFlow ? normalizeSteps(srcFlow.policies?.['enforced'] || []) : [];
    const ingressSteps = dstFlow ? normalizeSteps(dstFlow.policies?.['enforced'] || []) : [];

    const egressDenied = egressSteps.length > 0 &&
        (egressSteps[egressSteps.length - 1].action === 'Deny' ||
         egressSteps[egressSteps.length - 1].action === 'Default Deny');

    const egressTiers = getOrderedTiers(egressSteps);
    const ingressTiers = egressDenied ? [] : getOrderedTiers(ingressSteps);

    // Layout
    const srcW = 130;
    const dstW = 130;
    const netW = 36;
    const centerX = width / 2;

    const eLeft = srcW + 15;
    const eRight = centerX - netW / 2 - 8;
    const iLeft = centerX + netW / 2 + 8;
    const iRight = width - dstW - 15;

    const placeTiers = (tiers: string[], left: number, right: number) => {
        const n = tiers.length;
        if (n === 0) return new Map<string, { tierX: number; dotX: number }>();
        const totalW = right - left;
        const slotW = totalW / n;
        return new Map(tiers.map((t, i) => [t, {
            tierX: left + i * slotW,
            dotX: left + i * slotW + TIER_W + (slotW - TIER_W) / 2,
        }]));
    };

    const eTierMap = placeTiers(egressTiers, eLeft, eRight);
    const iTierMap = placeTiers(ingressTiers, iLeft, iRight);
    const cy = SVG_H / 2;

    // Build segments and dots
    type Dot = { x: number; color: string; step: Step; r: number };
    type Seg = { x1: number; x2: number; color: string };

    const eDots: Dot[] = [];
    const eSegs: Seg[] = [];
    const eColor = egressDenied ? ACTION_COLORS.Deny : ACTION_COLORS.Allow;
    let ex = eLeft;

    // Entry line
    eSegs.push({ x1: srcW + 4, x2: eLeft, color: eColor });

    for (const step of egressSteps) {
        if (step.isKnsProfile) {
            const dx = eRight - 14;
            eSegs.push({ x1: ex, x2: dx - DOT_R, color: ACTION_COLORS.Allow });
            eDots.push({ x: dx, color: ACTION_COLORS['Default Allow'], step, r: DOT_R + 2 });
            ex = dx + DOT_R + 4;
            break;
        }
        const tp = eTierMap.get(step.tier);
        if (!tp) continue;
        const dx = tp.dotX;
        eSegs.push({ x1: ex, x2: dx - DOT_R - 2, color: eColor });
        const c = step.isTrigger ? '#718096' : (ACTION_COLORS[step.action] || '#3182CE');
        eDots.push({ x: dx, color: c, step, r: step.isTerminal ? DOT_R + 2 : DOT_R });
        ex = dx + DOT_R + 4;
        if (step.isTerminal) break;
    }

    if (!egressDenied && egressSteps.length > 0) {
        eSegs.push({ x1: ex, x2: centerX - netW / 2 - 2, color: eColor });
    }

    const iDots: Dot[] = [];
    const iSegs: Seg[] = [];

    if (!egressDenied && ingressSteps.length > 0) {
        const iLast = ingressSteps[ingressSteps.length - 1];
        const iDenied = iLast && (iLast.action === 'Deny' || iLast.action === 'Default Deny');
        const iColor = iDenied ? ACTION_COLORS.Deny : ACTION_COLORS.Allow;
        let ix = iLeft;

        iSegs.push({ x1: centerX + netW / 2 + 2, x2: iLeft, color: iColor });

        for (const step of ingressSteps) {
            if (step.isKnsProfile) {
                const dx = iRight - 14;
                iSegs.push({ x1: ix, x2: dx - DOT_R, color: ACTION_COLORS.Allow });
                iDots.push({ x: dx, color: ACTION_COLORS['Default Allow'], step, r: DOT_R + 2 });
                ix = dx + DOT_R + 4;
                break;
            }
            const tp = iTierMap.get(step.tier);
            if (!tp) continue;
            const dx = tp.dotX;
            iSegs.push({ x1: ix, x2: dx - DOT_R - 2, color: iColor });
            const c = step.isTrigger ? '#718096' : (ACTION_COLORS[step.action] || '#3182CE');
            iDots.push({ x: dx, color: c, step, r: step.isTerminal ? DOT_R + 2 : DOT_R });
            ix = dx + DOT_R + 4;
            if (step.isTerminal) break;
        }

        if (!iDenied) {
            iSegs.push({ x1: ix, x2: iRight + 10, color: iColor });
        }
    }

    const showStepTooltip = (step: Step, e: React.MouseEvent) => {
        setTooltip({ type: 'step', step, x: e.clientX, y: e.clientY });
    };
    const showTierTooltip = (tier: string, side: string, e: React.MouseEvent) => {
        setTooltip({ type: 'tier', tier, side, x: e.clientX, y: e.clientY });
    };

    return (
        <Box position='relative'>
            <svg width={width} height={SVG_H}>
                {/* Egress tier bars */}
                {Array.from(eTierMap.entries()).map(([tier, pos]) => (
                    <g key={`et-${tier}`} style={{ cursor: 'default' }}
                        onMouseEnter={(e) => showTierTooltip(tier, 'egress', e)}
                        onMouseLeave={() => setTooltip(null)}>
                        <rect x={pos.tierX} y={2} width={TIER_W} height={SVG_H - 4} rx={3}
                            fill='#4A5568' stroke='#A0AEC0' strokeWidth={1} opacity={0.9} />
                        <text x={pos.tierX + TIER_W / 2} y={SVG_H / 2}
                            textAnchor='middle' dominantBaseline='central'
                            transform={`rotate(-90, ${pos.tierX + TIER_W / 2}, ${SVG_H / 2})`}
                            fontSize={7} fontWeight='bold' fill='#E2E8F0' fontFamily='monospace'>
                            {(tier === '_profile_' ? 'PROFILE' : tier).toUpperCase()}
                        </text>
                    </g>
                ))}

                {/* Ingress tier bars */}
                {Array.from(iTierMap.entries()).map(([tier, pos]) => (
                    <g key={`it-${tier}`} style={{ cursor: 'default' }}
                        onMouseEnter={(e) => showTierTooltip(tier, 'ingress', e)}
                        onMouseLeave={() => setTooltip(null)}>
                        <rect x={pos.tierX} y={2} width={TIER_W} height={SVG_H - 4} rx={3}
                            fill='#4A5568' stroke='#A0AEC0' strokeWidth={1} opacity={0.9} />
                        <text x={pos.tierX + TIER_W / 2} y={SVG_H / 2}
                            textAnchor='middle' dominantBaseline='central'
                            transform={`rotate(-90, ${pos.tierX + TIER_W / 2}, ${SVG_H / 2})`}
                            fontSize={7} fontWeight='bold' fill='#E2E8F0' fontFamily='monospace'>
                            {(tier === '_profile_' ? 'PROFILE' : tier).toUpperCase()}
                        </text>
                    </g>
                ))}

                {/* Network zone — two vertical borders with a cloud/network icon */}
                <line x1={centerX - netW / 2} y1={6} x2={centerX - netW / 2} y2={SVG_H - 6}
                    stroke='#4A5568' strokeWidth={1.5} strokeDasharray='3,3' />
                <line x1={centerX + netW / 2} y1={6} x2={centerX + netW / 2} y2={SVG_H - 6}
                    stroke='#4A5568' strokeWidth={1.5} strokeDasharray='3,3' />
                {/* Simple network icon: two small arrows */}
                <g opacity={0.5}>
                    <path d={`M${centerX - 8},${cy - 4} L${centerX + 2},${cy - 4}`} stroke='#718096' strokeWidth={1.5} fill='none' markerEnd='url(#arrowR)' />
                    <path d={`M${centerX + 8},${cy + 4} L${centerX - 2},${cy + 4}`} stroke='#718096' strokeWidth={1.5} fill='none' markerEnd='url(#arrowL)' />
                </g>
                <defs>
                    <marker id='arrowR' markerWidth='4' markerHeight='4' refX='3' refY='2' orient='auto'>
                        <path d='M0,0 L4,2 L0,4' fill='#718096' />
                    </marker>
                    <marker id='arrowL' markerWidth='4' markerHeight='4' refX='1' refY='2' orient='auto'>
                        <path d='M4,0 L0,2 L4,4' fill='#718096' />
                    </marker>
                </defs>

                {/* Egress segments */}
                {eSegs.map((s, i) => (
                    <line key={`es-${i}`} x1={s.x1} y1={cy} x2={s.x2} y2={cy}
                        stroke={s.color} strokeWidth={3} strokeOpacity={0.5} strokeLinecap='round' />
                ))}

                {/* Network bridge */}
                {!egressDenied && (
                    <line x1={centerX - netW / 2 + 2} y1={cy} x2={centerX + netW / 2 - 2} y2={cy}
                        stroke='#4A5568' strokeWidth={2} strokeOpacity={0.4}
                        strokeDasharray='3,3' strokeLinecap='round' />
                )}

                {/* Ingress segments */}
                {iSegs.map((s, i) => (
                    <line key={`is-${i}`} x1={s.x1} y1={cy} x2={s.x2} y2={cy}
                        stroke={s.color} strokeWidth={3} strokeOpacity={0.5} strokeLinecap='round' />
                ))}

                {/* Egress dots (no labels — hover for details) */}
                {eDots.map((dot, i) => (
                    <circle key={`ed-${i}`} cx={dot.x} cy={cy} r={dot.r}
                        fill={dot.color}
                        stroke={dot.step.isTerminal ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.15)'}
                        strokeWidth={dot.step.isTerminal ? 1.5 : 1}
                        style={{ cursor: 'pointer' }}
                        onMouseEnter={(e) => showStepTooltip(dot.step, e)}
                        onMouseLeave={() => setTooltip(null)}
                    />
                ))}

                {/* Ingress dots */}
                {iDots.map((dot, i) => (
                    <circle key={`id-${i}`} cx={dot.x} cy={cy} r={dot.r}
                        fill={dot.color}
                        stroke={dot.step.isTerminal ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.15)'}
                        strokeWidth={dot.step.isTerminal ? 1.5 : 1}
                        style={{ cursor: 'pointer' }}
                        onMouseEnter={(e) => showStepTooltip(dot.step, e)}
                        onMouseLeave={() => setTooltip(null)}
                    />
                ))}

                {/* Source label */}
                <text x={8} y={cy} dy='0.35em' fontSize={11} fill='#E2E8F0' fontFamily='monospace' fontWeight='bold'>
                    {cleanName(flow.source_name)}
                </text>
                <text x={8} y={cy + 13} fontSize={8} fill='#4A5568' fontFamily='monospace'>
                    {flow.source_namespace}
                </text>

                {/* Destination label */}
                <text x={width - 8} y={cy} dy='0.35em' textAnchor='end'
                    fontSize={11} fontFamily='monospace' fontWeight='bold'
                    fill={egressDenied ? '#4A5568' : '#E2E8F0'}
                    fontStyle={egressDenied ? 'italic' : undefined}>
                    {egressDenied ? '✕ ' : ''}{cleanName(flow.dest_name)}
                </text>
                <text x={width - 8} y={cy + 13} textAnchor='end' fontSize={8} fill='#4A5568' fontFamily='monospace'>
                    {flow.dest_namespace}
                </text>
            </svg>

            {/* Tooltip — portaled to body to escape overflow clipping */}
            {tooltip && ReactDOM.createPortal(
                <Box
                    position='fixed' left={tooltip.x + 14} top={tooltip.y - 40}
                    bg='gray.900' color='white' px={0} py={0}
                    borderRadius='lg' fontSize='xs' fontFamily='monospace'
                    pointerEvents='none' zIndex={10000}
                    border='1px solid' borderColor='gray.600' boxShadow='lg'
                    overflow='hidden'
                >
                    {tooltip.type === 'step' ? (
                        <table style={{ borderCollapse: 'collapse' }}>
                            <tbody>
                                {[
                                    ['Kind', tooltip.step.kind === 'EndOfTier' ? 'End of Tier' : shortKind(tooltip.step.kind)],
                                    ['Namespace', tooltip.step.namespace || '—'],
                                    ['Name', tooltip.step.label],
                                    ['Tier', tooltip.step.tier === '_profile_' ? 'profile' : tooltip.step.tier],
                                    ['Action', tooltip.step.action],
                                ].map(([label, value]) => (
                                    <tr key={label}>
                                        <td style={{ padding: '3px 10px', color: '#718096', whiteSpace: 'nowrap' }}>{label}</td>
                                        <td style={{
                                            padding: '3px 10px 3px 4px',
                                            color: label === 'Action' ? (ACTION_COLORS[value] || '#E2E8F0') : '#E2E8F0',
                                            fontWeight: label === 'Action' ? 'bold' : 'normal',
                                            whiteSpace: 'nowrap',
                                        }}>{value}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    ) : (
                        <table style={{ borderCollapse: 'collapse' }}>
                            <tbody>
                                <tr>
                                    <td style={{ padding: '3px 10px', color: '#718096' }}>Tier</td>
                                    <td style={{ padding: '3px 10px 3px 4px', color: '#E2E8F0', fontWeight: 'bold' }}>
                                        {tooltip.tier === '_profile_' ? 'profile' : tooltip.tier}
                                    </td>
                                </tr>
                                <tr>
                                    <td style={{ padding: '3px 10px', color: '#718096' }}>Side</td>
                                    <td style={{ padding: '3px 10px 3px 4px', color: '#A0AEC0' }}>{tooltip.side}</td>
                                </tr>
                            </tbody>
                        </table>
                    )}
                </Box>,
                document.body,
            )}
        </Box>
    );
};

export default FlowTraceViz;
