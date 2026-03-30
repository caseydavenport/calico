import { FlowLog } from '@/types/render';
import { Policy } from '@/types/api';

// A logical flow groups Src and Dst reporter entries for the same connection.
export type LogicalFlow = {
    id: string;
    label: string;
    sourceName: string;
    sourceNamespace: string;
    destName: string;
    destNamespace: string;
    protocol: string;
    destPort: string;
    action: string;
    volume: number;
    egressPolicies: Policy[];
    ingressPolicies: Policy[];
    flowIndices: number[];
};

export type DualSankeyNode = {
    id: string;
    label: string;
    type: 'tier' | 'policy' | 'flow' | 'action';
    side: 'egress' | 'center' | 'ingress';
    tier?: string;
    kind?: string;
};

export type DualSankeyLink = {
    source: string;
    target: string;
    value: number;
    flowIndices: number[];
};

export type DualSankeyData = {
    logicalFlows: LogicalFlow[];
    egressNodes: DualSankeyNode[];
    egressLinks: DualSankeyLink[];
    ingressNodes: DualSankeyNode[];
    ingressLinks: DualSankeyLink[];
    centerNodes: DualSankeyNode[];
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

const logicalFlowKey = (f: FlowLog) =>
    `${f.source_name}|${f.source_namespace}|${f.dest_name}|${f.dest_namespace}|${f.protocol}|${f.dest_port}`;

const flowLabel = (f: { sourceName: string; destName: string; destPort: string; protocol: string }) =>
    `${f.sourceName} → ${f.destName}:${f.destPort}/${f.protocol}`;

const policyNodeId = (side: string, p: Policy) => {
    const tier = p.tier || '_profile_';
    const ns = p.namespace ? p.namespace + '/' : '';
    return `${side}:policy:${p.kind}:${tier}/${ns}${p.name}`;
};

const tierNodeId = (side: string, tier: string) => `${side}:tier:${tier}`;

const policyLabel = (p: Policy) => {
    const name = p.namespace ? `${p.namespace}/${p.name}` : p.name;
    return `${name} (${p.action})`;
};

// Build the list of logical flows from raw flow data.
const buildLogicalFlows = (
    flows: FlowLog[],
    metric: 'bytes' | 'packets',
    usePending: boolean,
): LogicalFlow[] => {
    const policyKey = usePending ? 'pending' : 'enforced';
    const map = new Map<string, LogicalFlow>();

    for (let i = 0; i < flows.length; i++) {
        const f = flows[i];
        const key = logicalFlowKey(f);
        const volume = getVolume(f, metric);

        if (!map.has(key)) {
            map.set(key, {
                id: `flow:${key}`,
                label: flowLabel({
                    sourceName: f.source_name,
                    destName: f.dest_name,
                    destPort: String(f.dest_port),
                    protocol: f.protocol,
                }),
                sourceName: f.source_name,
                sourceNamespace: f.source_namespace,
                destName: f.dest_name,
                destNamespace: f.dest_namespace,
                protocol: f.protocol,
                destPort: String(f.dest_port),
                action: f.action,
                volume: 0,
                egressPolicies: [],
                ingressPolicies: [],
                flowIndices: [],
            });
        }

        const lf = map.get(key)!;
        lf.volume += volume;
        lf.flowIndices.push(i);

        // Worst action wins
        if (f.action === 'Deny') lf.action = 'Deny';

        const policies = [...(f.policies?.[policyKey] || [])].sort(
            (a, b) => (a.policy_index ?? 0) - (b.policy_index ?? 0),
        );

        if (f.reporter === 'Src' && policies.length > lf.egressPolicies.length) {
            lf.egressPolicies = policies;
        }
        if (f.reporter === 'Dst' && policies.length > lf.ingressPolicies.length) {
            lf.ingressPolicies = policies;
        }
    }

    return Array.from(map.values()).filter((lf) => lf.volume > 0);
};

// Build one side of the Sankey (egress or ingress) from a logical flow's
// policy trace. Returns nodes and links for that side.
type SideResult = {
    nodes: DualSankeyNode[];
    links: DualSankeyLink[];
    lastNodeId: string | null; // the terminal node before the center/action
};

const buildSide = (
    side: 'egress' | 'ingress',
    policies: Policy[],
    _flowId: string,
    volume: number,
    flowIndices: number[],
): SideResult => {
    const nodes: DualSankeyNode[] = [];
    const links: DualSankeyLink[] = [];
    const nodeSet = new Set<string>();

    const addNode = (n: DualSankeyNode) => {
        if (!nodeSet.has(n.id)) {
            nodeSet.add(n.id);
            nodes.push(n);
        }
    };

    if (policies.length === 0) {
        return { nodes: [], links: [], lastNodeId: null };
    }

    // Group consecutive policies by tier
    type TierGroup = { tier: string; policies: Policy[] };
    const tierGroups: TierGroup[] = [];
    for (const p of policies) {
        const tier = p.tier || '_profile_';
        if (tierGroups.length === 0 || tierGroups[tierGroups.length - 1].tier !== tier) {
            tierGroups.push({ tier, policies: [p] });
        } else {
            tierGroups[tierGroups.length - 1].policies.push(p);
        }
    }

    let prevNodeId: string | null = null;
    let terminated = false;

    for (const group of tierGroups) {
        if (terminated) break;

        const skipTierNode = group.tier === '_profile_';
        const tierId = tierNodeId(side, group.tier);

        if (!skipTierNode) {
            addNode({
                id: tierId,
                label: group.tier,
                type: 'tier',
                side,
                tier: group.tier,
            });
            if (prevNodeId !== null) {
                links.push({ source: prevNodeId, target: tierId, value: volume, flowIndices });
            }
        }

        let lastPolId: string | null = null;

        for (const p of group.policies) {
            const isEndOfTier = !!p.trigger;
            const isKnsProfile = p.kind === 'Profile' && p.name.startsWith('kns.');

            if (isEndOfTier || isKnsProfile) {
                // Terminal — this side ends here. The action will be
                // represented by the link color into the center node.
                terminated = true;
                break;
            }

            const polId = policyNodeId(side, p);
            addNode({
                id: polId,
                label: policyLabel(p),
                type: 'policy',
                side,
                tier: group.tier,
                kind: p.kind,
            });

            const from = lastPolId ?? (skipTierNode ? prevNodeId : tierId);
            if (from !== null) {
                links.push({ source: from, target: polId, value: volume, flowIndices });
            } else if (!skipTierNode) {
                links.push({ source: tierId, target: polId, value: volume, flowIndices });
            }
            lastPolId = polId;
        }

        if (lastPolId !== null) {
            prevNodeId = lastPolId;
        } else if (!skipTierNode) {
            prevNodeId = tierId;
        }
    }

    return { nodes, links, lastNodeId: prevNodeId };
};

export const buildDualSankey = (
    flows: FlowLog[],
    metric: 'bytes' | 'packets' = 'bytes',
    usePending = false,
): DualSankeyData => {
    const logicalFlows = buildLogicalFlows(flows, metric, usePending);

    const allEgressNodes: DualSankeyNode[] = [];
    const allIngressNodes: DualSankeyNode[] = [];
    const centerNodes: DualSankeyNode[] = [];

    const egressNodeSet = new Set<string>();
    const ingressNodeSet = new Set<string>();
    const egressLinkSet = new Map<string, DualSankeyLink>();
    const ingressLinkSet = new Map<string, DualSankeyLink>();

    for (const lf of logicalFlows) {
        // Center node for this logical flow
        centerNodes.push({
            id: lf.id,
            label: lf.label,
            type: 'flow',
            side: 'center',
        });

        // Egress side
        const egress = buildSide('egress', lf.egressPolicies, lf.id, lf.volume, lf.flowIndices);
        for (const n of egress.nodes) {
            if (!egressNodeSet.has(n.id)) {
                egressNodeSet.add(n.id);
                allEgressNodes.push(n);
            }
        }
        for (const l of egress.links) {
            const key = `${l.source}|${l.target}`;
            const existing = egressLinkSet.get(key);
            if (existing) {
                existing.value += l.value;
                existing.flowIndices.push(...l.flowIndices);
            } else {
                egressLinkSet.set(key, { ...l });
            }
        }
        // Link egress last node → center
        if (egress.lastNodeId) {
            const key = `${egress.lastNodeId}|${lf.id}`;
            const existing = egressLinkSet.get(key);
            if (existing) {
                existing.value += lf.volume;
                existing.flowIndices.push(...lf.flowIndices);
            } else {
                egressLinkSet.set(key, {
                    source: egress.lastNodeId,
                    target: lf.id,
                    value: lf.volume,
                    flowIndices: [...lf.flowIndices],
                });
            }
        }

        // Ingress side (links go center → ingress, so "source" is center)
        const ingress = buildSide('ingress', lf.ingressPolicies, lf.id, lf.volume, lf.flowIndices);
        for (const n of ingress.nodes) {
            if (!ingressNodeSet.has(n.id)) {
                ingressNodeSet.add(n.id);
                allIngressNodes.push(n);
            }
        }
        // For the ingress side, we need to reverse the link direction
        // since the Sankey will be mirrored. In the mirrored view,
        // traffic flows center → tier → policy. But d3 still needs
        // source → target to go left-to-right, so we keep them as-is
        // and mirror the X coordinates after layout.
        for (const l of ingress.links) {
            const key = `${l.source}|${l.target}`;
            const existing = ingressLinkSet.get(key);
            if (existing) {
                existing.value += l.value;
                existing.flowIndices.push(...l.flowIndices);
            } else {
                ingressLinkSet.set(key, { ...l });
            }
        }
        // Link center → ingress first node
        if (ingress.nodes.length > 0) {
            // Find the first tier or policy node
            const firstIngressNode = ingress.links.length > 0
                ? ingress.links[0].source
                : ingress.nodes[0].id;
            const key = `${lf.id}|${firstIngressNode}`;
            const existing = ingressLinkSet.get(key);
            if (existing) {
                existing.value += lf.volume;
                existing.flowIndices.push(...lf.flowIndices);
            } else {
                ingressLinkSet.set(key, {
                    source: lf.id,
                    target: firstIngressNode,
                    value: lf.volume,
                    flowIndices: [...lf.flowIndices],
                });
            }
        }
    }

    return {
        logicalFlows,
        egressNodes: allEgressNodes,
        egressLinks: Array.from(egressLinkSet.values()),
        ingressNodes: allIngressNodes,
        ingressLinks: Array.from(ingressLinkSet.values()),
        centerNodes,
    };
};
