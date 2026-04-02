import React from 'react';
import { FlowLog } from '@/types/render';
import { Policy } from '@/types/api';
import { Box, Flex, Text } from '@chakra-ui/react';

type Props = {
    flow: FlowLog;
    width?: number;
};

const ACTION_COLORS: Record<string, string> = {
    Allow: '#38A169', 'Default Allow': '#68D391',
    Deny: '#E53E3E', 'Default Deny': '#FC8181',
    Pass: '#3182CE', 'N/A': '#718096',
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

type Step = {
    label: string;
    shortLabel: string;
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
        const isKns = p.kind === 'Profile' && p.name.startsWith('kns.');
        const isTrigger = !!p.trigger;

        if (isTrigger) {
            const trigger = p.trigger as Policy;
            steps.push({
                label: `${shortKind(trigger.kind)}: ${trigger.name}`,
                shortLabel: trigger.name.replace(/.*\./, ''),
                action: 'N/A',
                tier: trigger.tier || 'default',
                isTerminal: false,
                isTrigger: true,
                isKnsProfile: false,
            });
            const act = p.action === 'Deny' ? 'Default Deny' : p.action;
            steps.push({
                label: `End of Tier ${p.tier || 'default'}`,
                shortLabel: `End of ${(p.tier || 'default').replace(/.*\./, '')}`,
                action: act,
                tier: p.tier || 'default',
                isTerminal: true,
                isTrigger: false,
                isKnsProfile: false,
            });
            break;
        }

        if (isKns) {
            steps.push({
                label: 'Default Allow (Profile)',
                shortLabel: 'Default Allow',
                action: 'Allow',
                tier: 'profile',
                isTerminal: true,
                isTrigger: false,
                isKnsProfile: true,
            });
            break;
        }

        steps.push({
            label: `${shortKind(p.kind)}: ${p.name}`,
            shortLabel: p.name.replace(/.*\./, ''),
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

const FlowTraceViz: React.FC<Props> = ({ flow, width = 900 }) => {
    const egressSteps = normalizeSteps(
        [...(flow.policies?.['enforced'] || [])].filter(
            // Src-reported flows show egress; if no reporter field, show all
            () => true,
        ),
    );

    // Determine egress vs ingress
    const isEgress = flow.reporter === 'Src';
    const sideLabel = isEgress ? 'EGRESS' : 'INGRESS';

    const steps = egressSteps;
    const outcome = steps.length > 0 ? steps[steps.length - 1].action : flow.action;
    const isDenied = outcome === 'Deny' || outcome === 'Default Deny';

    // Layout constants
    const srcX = 10;
    const stepsStart = 150;
    const stepsEnd = width - 150;
    const dstX = width - 10;
    const cy = 30;
    const dotR = 8;
    const stepSpacing = steps.length > 0 ? (stepsEnd - stepsStart) / (steps.length) : 0;

    // Group steps by tier for background bars
    const tierRanges: { tier: string; startIdx: number; endIdx: number }[] = [];
    let currentTier = '';
    steps.forEach((s, i) => {
        if (s.tier !== currentTier) {
            if (currentTier) {
                tierRanges[tierRanges.length - 1].endIdx = i - 1;
            }
            tierRanges.push({ tier: s.tier, startIdx: i, endIdx: i });
            currentTier = s.tier;
        } else {
            tierRanges[tierRanges.length - 1].endIdx = i;
        }
    });

    const svgH = 70;

    return (
        <Box>
            <Flex gap={6} mb={2} align='center'>
                <Text fontSize='10px' color='gray.500' fontFamily='monospace' fontWeight='bold'>
                    {sideLabel} POLICY TRACE
                </Text>
                <Flex gap={3} fontSize='10px' fontFamily='monospace' color='gray.600'>
                    <Flex align='center' gap={1}>
                        <Box w='8px' h='8px' borderRadius='full' bg='#3182CE' /> Pass
                    </Flex>
                    <Flex align='center' gap={1}>
                        <Box w='8px' h='8px' borderRadius='full' bg='#38A169' /> Allow
                    </Flex>
                    <Flex align='center' gap={1}>
                        <Box w='8px' h='8px' borderRadius='full' bg='#E53E3E' /> Deny
                    </Flex>
                    <Flex align='center' gap={1}>
                        <Box w='8px' h='8px' borderRadius='full' bg='#718096' /> N/A
                    </Flex>
                </Flex>
            </Flex>

            <svg width={width} height={svgH}>
                {/* Tier background bars */}
                {tierRanges.map((tr, i) => {
                    const x1 = stepsStart + tr.startIdx * stepSpacing - 10;
                    const x2 = stepsStart + (tr.endIdx + 1) * stepSpacing + 10;
                    return (
                        <g key={`tier-${i}`}>
                            <rect
                                x={x1} y={4} width={x2 - x1} height={svgH - 8}
                                rx={6} fill='rgba(255,255,255,0.03)'
                                stroke='rgba(255,255,255,0.06)' strokeWidth={1}
                            />
                            <text x={x1 + 6} y={16} fontSize={9} fill='#4A5568' fontFamily='monospace' fontWeight='bold'>
                                {tr.tier}
                            </text>
                        </g>
                    );
                })}

                {/* Source label and entry line */}
                <text x={srcX} y={cy} dy='0.35em' fontSize={11} fill='#E2E8F0' fontFamily='monospace' fontWeight='bold'>
                    {cleanName(flow.source_name)}
                </text>
                <text x={srcX} y={cy + 14} fontSize={9} fill='#4A5568' fontFamily='monospace'>
                    {flow.source_namespace}
                </text>
                <line
                    x1={stepsStart - 20} y1={cy} x2={stepsStart + (steps.length > 0 ? 0 : stepSpacing) - dotR} y2={cy}
                    stroke={isDenied ? ACTION_COLORS.Deny : ACTION_COLORS.Allow}
                    strokeWidth={3} strokeLinecap='round' strokeOpacity={0.5}
                />

                {/* Policy dots and connecting lines */}
                {steps.map((step, i) => {
                    const x = stepsStart + (i + 0.5) * stepSpacing;
                    const color = step.isTrigger
                        ? '#718096'
                        : step.isKnsProfile
                          ? ACTION_COLORS['Default Allow']
                          : ACTION_COLORS[step.action] || '#3182CE';

                    // Line to next step or to dest
                    const nextX = i < steps.length - 1
                        ? stepsStart + (i + 1.5) * stepSpacing
                        : isDenied ? x + dotR + 20 : dstX - 60;
                    const lineColor = step.isTerminal
                        ? color
                        : isDenied ? ACTION_COLORS.Deny : ACTION_COLORS.Allow;

                    return (
                        <g key={i}>
                            {/* Connecting line */}
                            {(i < steps.length - 1 || !isDenied) && (
                                <line
                                    x1={x + dotR + 2} y1={cy}
                                    x2={Math.min(nextX - dotR - 2, nextX)} y2={cy}
                                    stroke={lineColor}
                                    strokeWidth={3} strokeLinecap='round'
                                    strokeOpacity={step.isTerminal && isDenied ? 0 : 0.4}
                                    strokeDasharray={step.isTerminal && !isDenied ? undefined : undefined}
                                />
                            )}

                            {/* Dot */}
                            <circle
                                cx={x} cy={cy} r={step.isTerminal ? dotR + 2 : dotR}
                                fill={color}
                                stroke={step.isTerminal ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.15)'}
                                strokeWidth={step.isTerminal ? 2 : 1}
                            />

                            {/* Label below */}
                            <text
                                x={x} y={cy + dotR + 14}
                                textAnchor='middle' fontSize={9}
                                fontFamily='monospace'
                                fill={step.isTerminal ? color : '#A0AEC0'}
                                fontWeight={step.isTerminal ? 'bold' : 'normal'}
                            >
                                {step.shortLabel}
                            </text>

                            {/* Action above terminal dots */}
                            {step.isTerminal && (
                                <text
                                    x={x} y={cy - dotR - 6}
                                    textAnchor='middle' fontSize={9}
                                    fontFamily='monospace' fontWeight='bold'
                                    fill={color}
                                >
                                    {step.action}
                                </text>
                            )}
                        </g>
                    );
                })}

                {/* Network zone (if not denied) */}
                {!isDenied && steps.length > 0 && (
                    <g>
                        <rect
                            x={stepsEnd + 15} y={cy - 10}
                            width={30} height={20}
                            rx={4}
                            fill='url(#net-pattern-trace)' opacity={0.4}
                            stroke='#2D3748' strokeWidth={1}
                        />
                        <defs>
                            <pattern id='net-pattern-trace' patternUnits='userSpaceOnUse' width='6' height='6'>
                                <path d='M0,6 L6,0' stroke='#2D3748' strokeWidth={0.5} />
                            </pattern>
                        </defs>
                    </g>
                )}

                {/* Destination label */}
                <text
                    x={dstX} y={cy} dy='0.35em'
                    textAnchor='end' fontSize={11}
                    fill={isDenied ? '#4A5568' : '#E2E8F0'}
                    fontFamily='monospace' fontWeight='bold'
                    fontStyle={isDenied ? 'italic' : undefined}
                >
                    {isDenied ? '✕ ' : ''}{cleanName(flow.dest_name)}
                </text>
                <text x={dstX} y={cy + 14} textAnchor='end' fontSize={9} fill='#4A5568' fontFamily='monospace'>
                    {flow.dest_namespace}
                </text>
            </svg>
        </Box>
    );
};

export default FlowTraceViz;
