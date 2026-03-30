import { FlowLog } from '@/types/render';
import { Policy } from '@/types/api';

export type LogicalFlow = {
    id: string;
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

// A connection groups all logical flows between the same source and dest.
export type Connection = {
    id: string;
    sourceName: string;
    sourceNamespace: string;
    destName: string;
    destNamespace: string;
    totalVolume: number;
    flows: LogicalFlow[];
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
    connections: Connection[];
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

// Key for a single reporter-specific flow (includes action since same
// src/dst can have both Allow and Deny flows).
const flowKey = (f: FlowLog) =>
    `${f.source_name}|${f.source_namespace}|${f.dest_name}|${f.dest_namespace}|${f.protocol}|${f.dest_port}|${f.action}`;

// Key for a connection (source/dest pair regardless of action/protocol).
// connectionKey groups flows by source/dest pair (unused directly but
// the same logic is in buildConnections).
// const connectionKey = (f: FlowLog) =>
//     `${f.source_name}|${f.source_namespace}|${f.dest_name}|${f.dest_namespace}`;

const buildLogicalFlows = (
    flows: FlowLog[],
    metric: 'bytes' | 'packets',
    usePending: boolean,
): LogicalFlow[] => {
    const policyKey = usePending ? 'pending' : 'enforced';
    const map = new Map<string, LogicalFlow>();

    for (let i = 0; i < flows.length; i++) {
        const f = flows[i];
        const key = flowKey(f);
        const volume = getVolume(f, metric);

        if (!map.has(key)) {
            map.set(key, {
                id: `flow:${key}`,
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

const buildConnections = (_flows: FlowLog[], logicalFlows: LogicalFlow[]): Connection[] => {
    // Group logical flows by connection (same src/dst name+namespace)
    const map = new Map<string, Connection>();

    for (const lf of logicalFlows) {
        const key = `${lf.sourceName}|${lf.sourceNamespace}|${lf.destName}|${lf.destNamespace}`;
        if (!map.has(key)) {
            map.set(key, {
                id: `conn:${key}`,
                sourceName: lf.sourceName,
                sourceNamespace: lf.sourceNamespace,
                destName: lf.destName,
                destNamespace: lf.destNamespace,
                totalVolume: 0,
                flows: [],
            });
        }
        const conn = map.get(key)!;
        conn.totalVolume += lf.volume;
        conn.flows.push(lf);
    }

    // Sort by volume descending
    return Array.from(map.values()).sort((a, b) => b.totalVolume - a.totalVolume);
};

export const buildDualSankey = (
    flows: FlowLog[],
    metric: 'bytes' | 'packets' = 'bytes',
    usePending = false,
): DualSankeyData => {
    const logicalFlows = buildLogicalFlows(flows, metric, usePending);
    const connections = buildConnections(flows, logicalFlows);

    return {
        logicalFlows,
        connections,
        // These are unused now — the DualSankeyDiagram does its own layout
        // from connections. Kept for API compatibility.
        egressNodes: [],
        egressLinks: [],
        ingressNodes: [],
        ingressLinks: [],
        centerNodes: [],
    };
};
