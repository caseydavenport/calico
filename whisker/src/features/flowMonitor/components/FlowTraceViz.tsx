import React from 'react';
import { FlowLog } from '@/types/render';
import { Policy } from '@/types/api';
// Box, Flex, Text unused — pure SVG component

type Props = {
    srcFlow?: FlowLog;  // Src-reported (egress trace)
    dstFlow?: FlowLog;  // Dst-reported (ingress trace)
    width?: number;
};

const ACTION_COLORS: Record<string, string> = {
    Allow: '#38A169', 'Default Allow': '#68D391',
    Deny: '#E53E3E', 'Default Deny': '#FC8181',
    Pass: '#3182CE', 'N/A': '#718096',
};

// shortKind unused in this component — labels use short names directly

const cleanName = (name: string) =>
    name.replace(/-[a-z0-9]{6,10}-\*$/, '-*');

type Step = {
    label: string;
    action: string;
    tier: string;
    isTerminal: boolean;
    isTrigger: boolean;
    isKnsProfile: boolean;
};

const normalizeSteps = (policies: Policy[]): Step[] => {
    const sorted = [...policies].sort((a, b) => (a.policy_index ?? 0) - (b.policy_index ?? 0));
    const steps: Step[] = [];
    for (const p of sorted) {
        if (p.kind === 'Profile' && p.name.startsWith('kns.')) {
            steps.push({ label: 'Default Allow', action: 'Allow', tier: '_profile_', isTerminal: true, isTrigger: false, isKnsProfile: true });
            break;
        }
        if (p.trigger) {
            const trigger = p.trigger as Policy;
            steps.push({ label: trigger.name.replace(/.*\./, ''), action: 'N/A', tier: trigger.tier || 'default', isTerminal: false, isTrigger: true, isKnsProfile: false });
            const act = p.action === 'Deny' ? 'Default Deny' : p.action;
            steps.push({ label: `End of ${(p.tier || 'default').replace(/.*\./, '')}`, action: act, tier: p.tier || 'default', isTerminal: true, isTrigger: false, isKnsProfile: false });
            break;
        }
        steps.push({
            label: p.name.replace(/.*\./, ''),
            action: p.action,
            tier: p.tier || 'default',
            isTerminal: p.action === 'Allow' || p.action === 'Deny',
            isTrigger: false,
            isKnsProfile: false,
        });
        if (p.action === 'Deny') break;
    }
    return steps;
};

// Collect unique tiers in order, putting _profile_ last
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

const TIER_W = 22;
const DOT_R = 7;
const SVG_H = 48;
const TIER_GAP = 8;

const FlowTraceViz: React.FC<Props> = ({ srcFlow, dstFlow, width = 900 }) => {
    const flow = srcFlow || dstFlow;
    if (!flow) return null;

    const egressSteps = srcFlow ? normalizeSteps(srcFlow.policies?.['enforced'] || []) : [];
    const ingressSteps = dstFlow ? normalizeSteps(dstFlow.policies?.['enforced'] || []) : [];

    // Determine if egress denied (ingress won't be reached)
    const egressDenied = egressSteps.length > 0 &&
        (egressSteps[egressSteps.length - 1].action === 'Deny' ||
         egressSteps[egressSteps.length - 1].action === 'Default Deny');

    const egressTiers = getOrderedTiers(egressSteps);
    const ingressTiers = egressDenied ? [] : getOrderedTiers(ingressSteps);

    // Layout regions
    const srcLabelW = 120;
    const dstLabelW = 120;
    const networkW = 40;
    const centerX = width / 2;
    const egressRegionLeft = srcLabelW + 10;
    const egressRegionRight = centerX - networkW / 2 - 5;
    const ingressRegionLeft = centerX + networkW / 2 + 5;
    const ingressRegionRight = width - dstLabelW - 10;

    // Place tiers as columns within each region
    const placeTiers = (tiers: string[], left: number, right: number) => {
        const totalW = right - left;
        const slotW = tiers.length > 0 ? totalW / tiers.length : totalW;
        return new Map(tiers.map((t, i) => [t, {
            tierX: left + i * slotW,
            polX: left + i * slotW + TIER_W + TIER_GAP,
            slotRight: left + (i + 1) * slotW,
        }]));
    };

    const eTierMap = placeTiers(egressTiers, egressRegionLeft, egressRegionRight);
    const iTierMap = placeTiers(ingressTiers, ingressRegionLeft, ingressRegionRight);

    const cy = SVG_H / 2;

    // Build egress dots and segments
    type Dot = { x: number; color: string; label: string; isTerminal: boolean; r: number };
    type Seg = { x1: number; x2: number; color: string; dashed?: boolean };

    const egressDots: Dot[] = [];
    const egressSegs: Seg[] = [];
    let ex = egressRegionLeft;
    const egressColor = egressDenied ? ACTION_COLORS.Deny : ACTION_COLORS.Allow;

    // Entry line from source
    egressSegs.push({ x1: srcLabelW, x2: egressRegionLeft, color: egressColor });

    for (const step of egressSteps) {
        if (step.tier === '_profile_' || step.isKnsProfile) {
            // Default Allow goes at the end
            const dx = egressRegionRight - 10;
            egressSegs.push({ x1: ex, x2: dx - DOT_R, color: ACTION_COLORS.Allow });
            egressDots.push({ x: dx, color: ACTION_COLORS['Default Allow'], label: 'Default Allow', isTerminal: true, r: DOT_R + 2 });
            ex = dx + DOT_R + 4;
            break;
        }
        const tierPos = eTierMap.get(step.tier);
        if (!tierPos) continue;
        const dx = tierPos.polX + DOT_R;
        egressSegs.push({ x1: ex, x2: dx - DOT_R - 2, color: egressColor });
        const dotColor = step.isTrigger ? '#718096' : (ACTION_COLORS[step.action] || '#3182CE');
        egressDots.push({ x: dx, color: dotColor, label: step.label, isTerminal: step.isTerminal, r: step.isTerminal ? DOT_R + 2 : DOT_R });
        ex = dx + DOT_R + 4;
        if (step.isTerminal) break;
    }

    // If not denied, draw line to network zone
    if (!egressDenied && egressSteps.length > 0) {
        egressSegs.push({ x1: ex, x2: centerX - networkW / 2, color: egressColor });
    }

    // Ingress dots and segments
    const ingressDots: Dot[] = [];
    const ingressSegs: Seg[] = [];

    if (!egressDenied && ingressSteps.length > 0) {
        let ix = ingressRegionLeft;
        const ingressLastStep = ingressSteps[ingressSteps.length - 1];
        const ingressDeniedLocal = ingressLastStep &&
            (ingressLastStep.action === 'Deny' || ingressLastStep.action === 'Default Deny');
        const ingressColor = ingressDeniedLocal ? ACTION_COLORS.Deny : ACTION_COLORS.Allow;

        // Line from network zone
        ingressSegs.push({ x1: centerX + networkW / 2, x2: ingressRegionLeft, color: ingressColor });

        for (const step of ingressSteps) {
            if (step.tier === '_profile_' || step.isKnsProfile) {
                const dx = ingressRegionRight - 10;
                ingressSegs.push({ x1: ix, x2: dx - DOT_R, color: ACTION_COLORS.Allow });
                ingressDots.push({ x: dx, color: ACTION_COLORS['Default Allow'], label: 'Default Allow', isTerminal: true, r: DOT_R + 2 });
                ix = dx + DOT_R + 4;
                break;
            }
            const tierPos = iTierMap.get(step.tier);
            if (!tierPos) continue;
            const dx = tierPos.polX + DOT_R;
            ingressSegs.push({ x1: ix, x2: dx - DOT_R - 2, color: ingressColor });
            const dotColor = step.isTrigger ? '#718096' : (ACTION_COLORS[step.action] || '#3182CE');
            ingressDots.push({ x: dx, color: dotColor, label: step.label, isTerminal: step.isTerminal, r: step.isTerminal ? DOT_R + 2 : DOT_R });
            ix = dx + DOT_R + 4;
            if (step.isTerminal) break;
        }

        // Line to destination
        if (!ingressDeniedLocal) {
            ingressSegs.push({ x1: ix, x2: ingressRegionRight, color: ingressColor });
        }
    }



    return (
        <svg width={width} height={SVG_H}>
            {/* Egress tier bars */}
            {Array.from(eTierMap.entries()).map(([tier, pos]) => (
                <g key={`et-${tier}`}>
                    <rect x={pos.tierX} y={2} width={TIER_W} height={SVG_H - 4} rx={3}
                        fill='#4A5568' stroke='#718096' strokeWidth={0.5} opacity={0.7} />
                    <text x={pos.tierX + TIER_W / 2} y={SVG_H / 2}
                        textAnchor='middle' dominantBaseline='central'
                        transform={`rotate(-90, ${pos.tierX + TIER_W / 2}, ${SVG_H / 2})`}
                        fontSize={8} fontWeight='bold' fill='#CBD5E0' fontFamily='monospace'>
                        {tier.toUpperCase()}
                    </text>
                </g>
            ))}

            {/* Ingress tier bars */}
            {Array.from(iTierMap.entries()).map(([tier, pos]) => (
                <g key={`it-${tier}`}>
                    <rect x={pos.tierX} y={2} width={TIER_W} height={SVG_H - 4} rx={3}
                        fill='#4A5568' stroke='#718096' strokeWidth={0.5} opacity={0.7} />
                    <text x={pos.tierX + TIER_W / 2} y={SVG_H / 2}
                        textAnchor='middle' dominantBaseline='central'
                        transform={`rotate(-90, ${pos.tierX + TIER_W / 2}, ${SVG_H / 2})`}
                        fontSize={8} fontWeight='bold' fill='#CBD5E0' fontFamily='monospace'>
                        {tier.toUpperCase()}
                    </text>
                </g>
            ))}

            {/* Network zone */}
            <defs>
                <pattern id='net-trace' patternUnits='userSpaceOnUse' width='6' height='6'>
                    <path d='M0,6 L6,0' stroke='#2D3748' strokeWidth={0.5} />
                </pattern>
            </defs>
            <rect x={centerX - networkW / 2} y={2} width={networkW} height={SVG_H - 4}
                rx={4} fill='url(#net-trace)' opacity={0.5}
                stroke='#2D3748' strokeWidth={1} />

            {/* Egress flow segments */}
            {egressSegs.map((seg, i) => (
                <line key={`es-${i}`} x1={seg.x1} y1={cy} x2={seg.x2} y2={cy}
                    stroke={seg.color} strokeWidth={3} strokeOpacity={0.5}
                    strokeLinecap='round' strokeDasharray={seg.dashed ? '4,3' : undefined} />
            ))}

            {/* Network bridge (gray dashed) */}
            {!egressDenied && (
                <line x1={centerX - networkW / 2 + 2} y1={cy} x2={centerX + networkW / 2 - 2} y2={cy}
                    stroke='#4A5568' strokeWidth={2} strokeOpacity={0.4}
                    strokeDasharray='3,3' strokeLinecap='round' />
            )}

            {/* Ingress flow segments */}
            {ingressSegs.map((seg, i) => (
                <line key={`is-${i}`} x1={seg.x1} y1={cy} x2={seg.x2} y2={cy}
                    stroke={seg.color} strokeWidth={3} strokeOpacity={0.5}
                    strokeLinecap='round' />
            ))}

            {/* Egress dots */}
            {egressDots.map((dot, i) => (
                <g key={`ed-${i}`}>
                    <circle cx={dot.x} cy={cy} r={dot.r} fill={dot.color}
                        stroke={dot.isTerminal ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.15)'}
                        strokeWidth={dot.isTerminal ? 1.5 : 1} />
                    <text x={dot.x} y={cy + dot.r + 11} textAnchor='middle'
                        fontSize={8} fontFamily='monospace'
                        fill={dot.isTerminal ? dot.color : '#A0AEC0'}
                        fontWeight={dot.isTerminal ? 'bold' : 'normal'}>
                        {dot.label}
                    </text>
                    {dot.isTerminal && (
                        <text x={dot.x} y={cy - dot.r - 4} textAnchor='middle'
                            fontSize={8} fontFamily='monospace' fontWeight='bold' fill={dot.color}>
                            {i === egressDots.length - 1 ? (egressDenied ? 'Deny' : 'Allow') : ''}
                        </text>
                    )}
                </g>
            ))}

            {/* Ingress dots */}
            {ingressDots.map((dot, i) => (
                <g key={`id-${i}`}>
                    <circle cx={dot.x} cy={cy} r={dot.r} fill={dot.color}
                        stroke={dot.isTerminal ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.15)'}
                        strokeWidth={dot.isTerminal ? 1.5 : 1} />
                    <text x={dot.x} y={cy + dot.r + 11} textAnchor='middle'
                        fontSize={8} fontFamily='monospace'
                        fill={dot.isTerminal ? dot.color : '#A0AEC0'}
                        fontWeight={dot.isTerminal ? 'bold' : 'normal'}>
                        {dot.label}
                    </text>
                </g>
            ))}

            {/* Source label */}
            <text x={8} y={cy - 6} fontSize={11} fill='#E2E8F0' fontFamily='monospace' fontWeight='bold'>
                {cleanName(flow.source_name)}
            </text>
            <text x={8} y={cy + 10} fontSize={8} fill='#4A5568' fontFamily='monospace'>
                {flow.source_namespace}
            </text>

            {/* Destination label */}
            <text x={width - 8} y={cy - 6} textAnchor='end'
                fontSize={11} fontFamily='monospace' fontWeight='bold'
                fill={egressDenied ? '#4A5568' : '#E2E8F0'}
                fontStyle={egressDenied ? 'italic' : undefined}>
                {egressDenied ? '✕ ' : ''}{cleanName(flow.dest_name)}
            </text>
            <text x={width - 8} y={cy + 10} textAnchor='end'
                fontSize={8} fill='#4A5568' fontFamily='monospace'>
                {flow.dest_namespace}
            </text>

            {/* Column labels */}
            <text x={srcLabelW + 5} y={8} fontSize={8} fill='#4A5568' fontFamily='monospace'>EGRESS</text>
            {!egressDenied && (
                <text x={ingressRegionLeft} y={8} fontSize={8} fill='#4A5568' fontFamily='monospace'>INGRESS</text>
            )}
        </svg>
    );
};

export default FlowTraceViz;
