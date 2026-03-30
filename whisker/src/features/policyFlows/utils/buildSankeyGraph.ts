import { FlowLog } from '@/types/render';
import { Policy } from '@/types/api';

export type SankeyNode = {
    id: string;
    label: string;
    type: 'tier' | 'policy' | 'action';
    tier?: string;
    kind?: string;
};

export type SankeyLink = {
    source: string;
    target: string;
    value: number;
};

// Maps a link key ("sourceId|targetId") to the indices of flows that traverse it.
export type LinkFlowMap = Map<string, number[]>;

export type SankeyGraph = {
    nodes: SankeyNode[];
    links: SankeyLink[];
    linkFlowMap: LinkFlowMap;
};

const policyNodeId = (p: Policy) => {
    const tier = p.tier || '_profile_';
    const ns = p.namespace ? p.namespace + '/' : '';
    return `policy:${p.kind}:${tier}/${ns}${p.name}`;
};

const tierNodeId = (tier: string) => `tier:${tier}`;
const actionNodeId = (action: string) => `action:${action}`;

const policyLabel = (p: Policy) => {
    const name = p.namespace ? `${p.namespace}/${p.name}` : p.name;
    return `${name} (${p.action})`;
};

const getVolume = (flow: FlowLog, metric: 'bytes' | 'packets'): number => {
    const toNum = (v: string | number | undefined): number => {
        if (v === undefined || v === null) return 0;
        if (typeof v === 'number') return v;
        return parseInt(v, 10) || 0;
    };
    if (metric === 'bytes') {
        return toNum(flow.bytes_in) + toNum(flow.bytes_out);
    }
    return toNum(flow.packets_in) + toNum(flow.packets_out);
};

// Key for grouping flows into logical connections (ignoring reporter).
const logicalFlowKey = (f: FlowLog) =>
    `${f.source_name}|${f.source_namespace}|${f.dest_name}|${f.dest_namespace}|${f.protocol}|${f.dest_port}|${f.action}`;

type LogicalFlow = {
    key: string;
    action: string;
    volume: number;
    // Merged policy trace: src-side first, then dst-side.
    policies: Policy[];
    // Indices into the original flows array.
    flowIndices: number[];
};

// Group raw flows into logical flows, merging Src and Dst reporter traces.
const buildLogicalFlows = (
    flows: FlowLog[],
    metric: 'bytes' | 'packets',
    usePending: boolean,
): LogicalFlow[] => {
    const map = new Map<
        string,
        { srcPolicies: Policy[]; dstPolicies: Policy[]; volume: number; action: string; flowIndices: number[] }
    >();

    const policyKey = usePending ? 'pending' : 'enforced';

    for (let i = 0; i < flows.length; i++) {
        const f = flows[i];
        const key = logicalFlowKey(f);
        const volume = getVolume(f, metric);

        if (!map.has(key)) {
            map.set(key, {
                srcPolicies: [],
                dstPolicies: [],
                volume: 0,
                action: f.action,
                flowIndices: [],
            });
        }
        const entry = map.get(key)!;
        entry.volume += volume;
        entry.flowIndices.push(i);

        const policies = [...(f.policies?.[policyKey] || [])].sort(
            (a, b) => (a.policy_index ?? 0) - (b.policy_index ?? 0),
        );

        if (f.reporter === 'Src') {
            // Keep the most detailed src trace we've seen.
            if (policies.length > entry.srcPolicies.length) {
                entry.srcPolicies = policies;
            }
        } else {
            if (policies.length > entry.dstPolicies.length) {
                entry.dstPolicies = policies;
            }
        }
    }

    const result: LogicalFlow[] = [];
    for (const [key, entry] of map) {
        // Merge: src egress policies, then dst ingress policies.
        const merged = [...entry.srcPolicies, ...entry.dstPolicies];
        result.push({
            key,
            action: entry.action,
            volume: entry.volume,
            policies: merged,
            flowIndices: entry.flowIndices,
        });
    }
    return result;
};

// Simple per-flow trace (no Src/Dst merging) for single-reporter views.
const buildSimpleFlows = (
    flows: FlowLog[],
    metric: 'bytes' | 'packets',
    usePending: boolean,
): LogicalFlow[] => {
    const policyKey = usePending ? 'pending' : 'enforced';
    return flows.map((f, i) => {
        const policies = [...(f.policies?.[policyKey] || [])].sort(
            (a, b) => (a.policy_index ?? 0) - (b.policy_index ?? 0),
        );
        return {
            key: `flow-${i}`,
            action: f.action,
            volume: getVolume(f, metric),
            policies,
            flowIndices: [i],
        };
    });
};

// Group consecutive policies by tier.
type TierGroup = {
    tier: string;
    policies: Policy[];
};

const groupByTier = (policies: Policy[]): TierGroup[] => {
    const groups: TierGroup[] = [];
    for (const p of policies) {
        const tier = p.tier || '_profile_';
        if (groups.length === 0 || groups[groups.length - 1].tier !== tier) {
            groups.push({ tier, policies: [p] });
        } else {
            groups[groups.length - 1].policies.push(p);
        }
    }
    return groups;
};

export const buildSankeyGraph = (
    flows: FlowLog[],
    metric: 'bytes' | 'packets' = 'bytes',
    usePending = false,
    reporterMode: 'combined' | 'Src' | 'Dst' = 'combined',
): SankeyGraph => {
    const nodesMap = new Map<string, SankeyNode>();
    const linksMap = new Map<string, number>();
    const linkFlowIndices = new Map<string, number[]>();

    const addNode = (id: string, node: SankeyNode) => {
        if (!nodesMap.has(id)) {
            nodesMap.set(id, node);
        }
    };

    const addLink = (source: string, target: string, value: number, flowIdxs: number[]) => {
        if (source === target) return;
        const key = `${source}|${target}`;
        linksMap.set(key, (linksMap.get(key) || 0) + value);
        if (!linkFlowIndices.has(key)) {
            linkFlowIndices.set(key, []);
        }
        linkFlowIndices.get(key)!.push(...flowIdxs);
    };

    const logicalFlows =
        reporterMode === 'combined'
            ? buildLogicalFlows(flows, metric, usePending)
            : buildSimpleFlows(flows, metric, usePending);

    for (const lf of logicalFlows) {
        const { policies, volume, flowIndices } = lf;
        if (volume === 0) continue;

        if (policies.length === 0) continue;

        const tierGroups = groupByTier(policies);

        let prevNodeId: string | null = null;

        for (let gi = 0; gi < tierGroups.length; gi++) {
            const group = tierGroups[gi];
            const tierLabel =
                group.tier === '_profile_' ? 'Profile' : group.tier;
            const tierId = tierNodeId(group.tier);
            const skipTierNode = group.tier === '_profile_';

            if (!skipTierNode) {
                addNode(tierId, {
                    id: tierId,
                    label: tierLabel,
                    type: 'tier',
                    tier: group.tier,
                });
            }

            if (prevNodeId !== null && !skipTierNode) {
                addLink(prevNodeId, tierId, volume, flowIndices);
            }

            let lastPolId: string | null = null;

            for (const p of group.policies) {
                const isEndOfTier = !!p.trigger;
                const isKnsProfile =
                    p.kind === 'Profile' && p.name.startsWith('kns.');

                if (isEndOfTier) {
                    const actId = actionNodeId(p.action);
                    addNode(actId, {
                        id: actId,
                        label: p.action,
                        type: 'action',
                    });
                    const from = lastPolId ?? tierId;
                    addLink(from, actId, volume, flowIndices);
                    lastPolId = null;
                    break;
                }

                // kns Profile is "Default Allow" only when it's the
                // very last policy in the entire merged trace (i.e.,
                // the terminal decision). Otherwise it's just Pass
                // and the flow continues to the next tier group.
                const isLastOverall =
                    gi === tierGroups.length - 1 &&
                    p === group.policies[group.policies.length - 1];

                if (isKnsProfile && isLastOverall) {
                    const actId = 'action:Default Allow';
                    addNode(actId, {
                        id: actId,
                        label: 'Default Allow',
                        type: 'action',
                    });
                    const from = lastPolId ?? (skipTierNode ? prevNodeId : tierId);
                    if (from !== null) {
                        addLink(from, actId, volume, flowIndices);
                    }
                    lastPolId = null;
                    break;
                }

                // Non-terminal kns Profile — skip it (it's just a
                // pass-through to the next tier, already handled by
                // the tier grouping).
                if (isKnsProfile) {
                    continue;
                }

                const polId = policyNodeId(p);
                const label = policyLabel(p);

                addNode(polId, {
                    id: polId,
                    label,
                    type: 'policy',
                    tier: group.tier,
                    kind: p.kind,
                });

                const from = lastPolId ?? (skipTierNode ? prevNodeId : tierId);
                if (from !== null) {
                    addLink(from, polId, volume, flowIndices);
                }
                lastPolId = polId;

                const isLastPolicy =
                    gi === tierGroups.length - 1 &&
                    p === group.policies[group.policies.length - 1];
                if (isLastPolicy && p.action !== 'Pass') {
                    const actId = actionNodeId(p.action);
                    addNode(actId, {
                        id: actId,
                        label: p.action,
                        type: 'action',
                    });
                    addLink(polId, actId, volume, flowIndices);
                }
            }

            if (lastPolId !== null) {
                prevNodeId = lastPolId;
            } else {
                prevNodeId = null;
                break;
            }
        }
    }

    const usedNodeIds = new Set<string>();
    const links: SankeyLink[] = [];
    for (const [key, value] of linksMap) {
        if (value <= 0) continue;
        const [source, target] = key.split('|');
        links.push({ source, target, value });
        usedNodeIds.add(source);
        usedNodeIds.add(target);
    }

    const nodes = Array.from(nodesMap.values()).filter((n) =>
        usedNodeIds.has(n.id),
    );

    return { nodes, links, linkFlowMap: linkFlowIndices };
};
