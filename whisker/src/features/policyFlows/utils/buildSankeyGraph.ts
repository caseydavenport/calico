import { FlowLog } from '@/types/render';
import { Policy } from '@/types/api';

export type SankeyNode = {
    id: string;
    label: string;
    type: 'tier' | 'policy' | 'action';
    tier?: string;
};

export type SankeyLink = {
    source: string;
    target: string;
    value: number;
};

export type SankeyGraph = {
    nodes: SankeyNode[];
    links: SankeyLink[];
};

const policyNodeId = (p: Policy) =>
    `policy:${p.tier || 'default'}/${p.namespace ? p.namespace + '/' : ''}${p.name}`;

const tierNodeId = (tier: string) => `tier:${tier || 'default'}`;
const actionNodeId = (action: string) => `action:${action}`;

const policyLabel = (p: Policy) => {
    if (p.namespace) {
        return `${p.namespace}/${p.name}`;
    }
    return p.name;
};

export const buildSankeyGraph = (
    flows: FlowLog[],
    metric: 'bytes' | 'packets' = 'bytes',
    usePending = false,
): SankeyGraph => {
    const nodesMap = new Map<string, SankeyNode>();
    const linksMap = new Map<string, number>();

    const addNode = (id: string, node: SankeyNode) => {
        if (!nodesMap.has(id)) {
            nodesMap.set(id, node);
        }
    };

    const addLink = (source: string, target: string, value: number) => {
        const key = `${source}|${target}`;
        linksMap.set(key, (linksMap.get(key) || 0) + value);
    };

    for (const flow of flows) {
        const volume =
            metric === 'bytes'
                ? parseInt(flow.bytes_in || '0') +
                  parseInt(flow.bytes_out || '0')
                : parseInt(flow.packets_in || '0') +
                  parseInt(flow.packets_out || '0');

        if (volume === 0) continue;

        const policyKey = usePending ? 'pending' : 'enforced';
        const policies: Policy[] = flow.policies?.[policyKey] || [];

        if (policies.length === 0) {
            // Flows with no policy trace go through a "Profile Default" path
            const tierId = tierNodeId('profile');
            const policyId = 'policy:profile/default';
            const actId = actionNodeId(flow.action);

            addNode(tierId, {
                id: tierId,
                label: 'Profile',
                type: 'tier',
            });
            addNode(policyId, {
                id: policyId,
                label: 'Default Profile',
                type: 'policy',
                tier: 'profile',
            });
            addNode(actId, {
                id: actId,
                label: flow.action,
                type: 'action',
            });
            addLink(tierId, policyId, volume);
            addLink(policyId, actId, volume);
            continue;
        }

        // Build the chain: tier -> first policy, policy -> policy, last policy -> action
        let prevNodeId: string | null = null;

        for (let i = 0; i < policies.length; i++) {
            const p = policies[i];
            const tierId = tierNodeId(p.tier);
            const polId = policyNodeId(p);

            addNode(tierId, {
                id: tierId,
                label: p.tier || 'default',
                type: 'tier',
            });
            addNode(polId, {
                id: polId,
                label: policyLabel(p),
                type: 'policy',
                tier: p.tier,
            });

            // Link tier -> policy for the first policy in each tier
            if (
                prevNodeId === null ||
                (i > 0 && policies[i - 1].tier !== p.tier)
            ) {
                addLink(tierId, polId, volume);
            }

            // Link previous policy -> this policy (within same tier)
            if (prevNodeId !== null && policies[i - 1]?.tier === p.tier) {
                addLink(prevNodeId, polId, volume);
            }

            // Cross-tier: previous policy -> this tier
            if (
                prevNodeId !== null &&
                i > 0 &&
                policies[i - 1].tier !== p.tier
            ) {
                addLink(prevNodeId, tierId, volume);
                addLink(tierId, polId, volume);
            }

            prevNodeId = polId;

            // Last policy links to its action
            if (i === policies.length - 1) {
                const actId = actionNodeId(p.action);
                addNode(actId, {
                    id: actId,
                    label: p.action,
                    type: 'action',
                });
                addLink(polId, actId, volume);
            }
        }
    }

    const nodes = Array.from(nodesMap.values());
    const links: SankeyLink[] = [];
    for (const [key, value] of linksMap) {
        const [source, target] = key.split('|');
        if (value > 0) {
            links.push({ source, target, value });
        }
    }

    return { nodes, links };
};
