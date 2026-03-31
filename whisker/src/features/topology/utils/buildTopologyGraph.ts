import { FlowLog } from '@/types/render';

export type TopologyNode = {
    id: string;
    name: string;
    namespace: string;
    totalBytes: number;
    type: 'workload' | 'external';
};

export type TopologyEdge = {
    id: string;
    source: string;
    target: string;
    bytes: number;
    packets: number;
    action: string;
    protocol: string;
    destPort: string;
};

export type TopologyGraph = {
    nodes: TopologyNode[];
    edges: TopologyEdge[];
};

const isExternal = (namespace: string) =>
    !namespace || namespace === '-' || namespace === '';

const nodeId = (name: string, namespace: string) =>
    `${isExternal(namespace) ? '_external_' : namespace}/${name}`;

export const buildTopologyGraph = (flows: FlowLog[]): TopologyGraph => {
    const nodesMap = new Map<string, TopologyNode>();
    const edgesMap = new Map<string, TopologyEdge>();

    const ensureNode = (
        name: string,
        namespace: string,
        bytes: number,
    ) => {
        const id = nodeId(name, namespace);
        const existing = nodesMap.get(id);
        if (existing) {
            existing.totalBytes += bytes;
        } else {
            nodesMap.set(id, {
                id,
                name,
                namespace: isExternal(namespace) ? '(external)' : namespace,
                totalBytes: bytes,
                type: isExternal(namespace) ? 'external' : 'workload',
            });
        }
        return id;
    };

    for (const flow of flows) {
        const bytes =
            parseInt(flow.bytes_in || '0') +
            parseInt(flow.bytes_out || '0');
        const packets =
            parseInt(flow.packets_in || '0') +
            parseInt(flow.packets_out || '0');

        const srcId = ensureNode(
            flow.source_name,
            flow.source_namespace,
            bytes,
        );
        const dstId = ensureNode(
            flow.dest_name,
            flow.dest_namespace,
            bytes,
        );

        const edgeKey = `${srcId}->${dstId}`;
        const existing = edgesMap.get(edgeKey);
        if (existing) {
            existing.bytes += bytes;
            existing.packets += packets;
            // If mixed actions, mark as "mixed"
            if (existing.action !== flow.action) {
                existing.action = 'Mixed';
            }
        } else {
            edgesMap.set(edgeKey, {
                id: edgeKey,
                source: srcId,
                target: dstId,
                bytes,
                packets,
                action: flow.action,
                protocol: flow.protocol,
                destPort: flow.dest_port,
            });
        }
    }

    return {
        nodes: Array.from(nodesMap.values()),
        edges: Array.from(edgesMap.values()),
    };
};

export const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024)
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};
