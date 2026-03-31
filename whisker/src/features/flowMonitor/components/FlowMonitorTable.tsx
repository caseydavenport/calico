import React from 'react';
import {
    Box, Flex, Text, Table, Thead, Tbody, Tr, Th, Td,
} from '@chakra-ui/react';
import { FlowLog } from '@/types/render';
import { Policy } from '@/types/api';

type Props = {
    flows: FlowLog[];
    pollInterval?: number; // ms between refreshes
};

const ACTION_COLORS: Record<string, string> = {
    Allow: '#38A169',
    Deny: '#E53E3E',
    Pass: '#3182CE',
};

const ACTION_BG: Record<string, string> = {
    Allow: 'rgba(56, 161, 105, 0.15)',
    Deny: 'rgba(229, 62, 62, 0.18)',
    Pass: 'rgba(49, 130, 206, 0.12)',
};

const STALE_BG = 'rgba(255, 255, 255, 0.015)';

const formatBytes = (b: number): string => {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
    return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

const toNum = (v: string | number | undefined): number => {
    if (v === undefined || v === null) return 0;
    if (typeof v === 'number') return v;
    return parseInt(v, 10) || 0;
};

const cleanName = (name: string) =>
    name.replace(/-[a-z0-9]{6,10}-\*$/, '-*');

const shortKind = (kind: string) => {
    const map: Record<string, string> = {
        CalicoNetworkPolicy: 'CNP',
        GlobalNetworkPolicy: 'GNP',
        NetworkPolicy: 'KNP',
        Profile: 'Profile',
    };
    return map[kind] || kind;
};

const policyChain = (policies: Policy[]): string => {
    if (!policies || policies.length === 0) return '—';
    return policies
        .sort((a, b) => (a.policy_index ?? 0) - (b.policy_index ?? 0))
        .map((p) => {
            if (p.kind === 'Profile' && p.name.startsWith('kns.'))
                return 'Default Allow';
            if (p.trigger) return `End of ${p.tier || 'default'}`;
            return `${shortKind(p.kind)}:${p.name}(${p.action})`;
        })
        .join(' → ');
};

// Unique key for a logical flow (merges Src/Dst reporters)
const flowKey = (f: FlowLog) =>
    `${f.source_name}|${f.source_namespace}|${f.dest_name}|${f.dest_namespace}|${f.protocol}|${f.dest_port}`;

type MonitoredFlow = {
    key: string;
    sourceName: string;
    sourceNamespace: string;
    destName: string;
    destNamespace: string;
    protocol: string;
    destPort: string;
    action: string;
    bytesIn: number;
    bytesOut: number;
    packetsIn: number;
    packetsOut: number;
    lastSeen: number; // timestamp ms
    firstSeen: number;
    reporter: string;
    egressPolicies: string;
    ingressPolicies: string;
};

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const REMOVE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

const FlowMonitorTable: React.FC<Props> = ({ flows }) => {
    const [now, setNow] = React.useState(Date.now());
    const flowMapRef = React.useRef(new Map<string, MonitoredFlow>());

    // Tick every 10s to update staleness
    React.useEffect(() => {
        const interval = setInterval(() => setNow(Date.now()), 10000);
        return () => clearInterval(interval);
    }, []);

    // Update flow map with latest data
    React.useEffect(() => {
        const map = flowMapRef.current;
        const seen = new Set<string>();

        for (const f of flows) {
            const key = flowKey(f);
            seen.add(key);
            const existing = map.get(key);
            const endTime = f.end_time.getTime();
            const bytesIn = toNum(f.bytes_in);
            const bytesOut = toNum(f.bytes_out);
            const packetsIn = toNum(f.packets_in);
            const packetsOut = toNum(f.packets_out);

            const policyKey = 'enforced';
            const policies = f.policies?.[policyKey] || [];
            const policySorted = [...policies].sort(
                (a, b) => (a.policy_index ?? 0) - (b.policy_index ?? 0),
            );
            const policyStr = policyChain(policySorted);

            if (existing) {
                // Update: take latest values
                if (endTime > existing.lastSeen) {
                    existing.lastSeen = endTime;
                }
                existing.action = f.action;
                existing.bytesIn = Math.max(existing.bytesIn, bytesIn);
                existing.bytesOut = Math.max(existing.bytesOut, bytesOut);
                existing.packetsIn = Math.max(existing.packetsIn, packetsIn);
                existing.packetsOut = Math.max(existing.packetsOut, packetsOut);
                if (f.reporter === 'Src') {
                    existing.egressPolicies = policyStr;
                } else {
                    existing.ingressPolicies = policyStr;
                }
            } else {
                map.set(key, {
                    key,
                    sourceName: f.source_name,
                    sourceNamespace: f.source_namespace,
                    destName: f.dest_name,
                    destNamespace: f.dest_namespace,
                    protocol: f.protocol,
                    destPort: String(f.dest_port),
                    action: f.action,
                    bytesIn,
                    bytesOut,
                    packetsIn,
                    packetsOut,
                    lastSeen: endTime,
                    firstSeen: f.start_time.getTime(),
                    reporter: f.reporter,
                    egressPolicies: f.reporter === 'Src' ? policyStr : '—',
                    ingressPolicies: f.reporter === 'Dst' ? policyStr : '—',
                });
            }
        }

        // Remove flows older than 15 minutes
        const cutoff = Date.now() - REMOVE_THRESHOLD_MS;
        for (const [key, entry] of map) {
            if (entry.lastSeen < cutoff) {
                map.delete(key);
            }
        }

        setNow(Date.now());
    }, [flows]);

    // Stable sort: only re-sort when the flow map changes (new/removed flows),
    // not on every tick. Staleness is applied visually per-row without re-ordering.
    const [sortGeneration, setSortGeneration] = React.useState(0);
    const prevFlowCountRef = React.useRef(0);

    React.useEffect(() => {
        const count = flowMapRef.current.size;
        if (count !== prevFlowCountRef.current) {
            prevFlowCountRef.current = count;
            setSortGeneration((g) => g + 1);
        }
    }, [flows]);

    const sortedFlows = React.useMemo(() => {
        void sortGeneration; // dependency trigger
        const all = Array.from(flowMapRef.current.values());
        // Sort by bytes descending — this order stays stable between refreshes
        all.sort((a, b) => (b.bytesIn + b.bytesOut) - (a.bytesIn + a.bytesOut));
        return all;
    }, [sortGeneration]);

    const formatAge = (lastSeen: number) => {
        const secs = Math.round((now - lastSeen) / 1000);
        if (secs < 60) return `${secs}s ago`;
        if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
        return `${Math.round(secs / 3600)}h ago`;
    };

    return (
        <Box overflowX='auto' overflowY='auto' h='100%'>
            <Table size='sm' variant='unstyled'>
                <Thead position='sticky' top={0} bg='gray.900' zIndex={2}>
                    <Tr>
                        <Th color='gray.500' fontSize='xs' px={3} py={2} fontFamily='monospace' textTransform='none'>Action</Th>
                        <Th color='gray.500' fontSize='xs' px={3} py={2} fontFamily='monospace' textTransform='none'>Source</Th>
                        <Th color='gray.500' fontSize='xs' px={3} py={2} fontFamily='monospace' textTransform='none'>Destination</Th>
                        <Th color='gray.500' fontSize='xs' px={3} py={2} fontFamily='monospace' textTransform='none'>Proto</Th>
                        <Th color='gray.500' fontSize='xs' px={3} py={2} fontFamily='monospace' textTransform='none'>Port</Th>
                        <Th color='gray.500' fontSize='xs' px={3} py={2} fontFamily='monospace' textTransform='none' isNumeric>Bytes</Th>
                        <Th color='gray.500' fontSize='xs' px={3} py={2} fontFamily='monospace' textTransform='none' isNumeric>Packets</Th>
                        <Th color='gray.500' fontSize='xs' px={3} py={2} fontFamily='monospace' textTransform='none'>Egress Policies</Th>
                        <Th color='gray.500' fontSize='xs' px={3} py={2} fontFamily='monospace' textTransform='none'>Ingress Policies</Th>
                        <Th color='gray.500' fontSize='xs' px={3} py={2} fontFamily='monospace' textTransform='none'>Last Seen</Th>
                    </Tr>
                </Thead>
                <Tbody>
                    {sortedFlows.map((f) => {
                        const isStale = now - f.lastSeen > STALE_THRESHOLD_MS;
                        const actionColor = ACTION_COLORS[f.action] || '#718096';
                        const rowBg = isStale ? STALE_BG : ACTION_BG[f.action] || 'transparent';
                        const textColor = isStale ? 'gray.600' : 'gray.300';
                        const nameColor = isStale ? 'gray.600' : 'gray.200';

                        return (
                            <Tr
                                key={f.key}
                                bg={rowBg}
                                _hover={{ bg: isStale ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.05)' }}
                                transition='background 0.3s ease'
                            >
                                <Td px={3} py={2}>
                                    <Flex align='center' gap={1.5}>
                                        <Box
                                            w='10px' h='10px' borderRadius='full'
                                            bg={isStale ? 'gray.600' : actionColor}
                                            transition='background 0.3s ease'
                                        />
                                        <Text
                                            fontSize='sm' fontFamily='monospace' fontWeight='bold'
                                            color={isStale ? 'gray.600' : actionColor}
                                            transition='color 0.3s ease'
                                        >
                                            {f.action}
                                        </Text>
                                    </Flex>
                                </Td>
                                <Td px={3} py={2}>
                                    <Text fontSize='sm' fontFamily='monospace' color={nameColor} fontWeight='600'>
                                        {cleanName(f.sourceName)}
                                    </Text>
                                    <Text fontSize='xs' fontFamily='monospace' color='gray.600'>
                                        {f.sourceNamespace}
                                    </Text>
                                </Td>
                                <Td px={3} py={2}>
                                    <Text fontSize='sm' fontFamily='monospace' color={nameColor} fontWeight='600'>
                                        {cleanName(f.destName)}
                                    </Text>
                                    <Text fontSize='xs' fontFamily='monospace' color='gray.600'>
                                        {f.destNamespace}
                                    </Text>
                                </Td>
                                <Td px={3} py={2}>
                                    <Text fontSize='sm' fontFamily='monospace' color={textColor}>
                                        {f.protocol}
                                    </Text>
                                </Td>
                                <Td px={3} py={2}>
                                    <Text fontSize='sm' fontFamily='monospace' color={textColor}>
                                        {f.destPort}
                                    </Text>
                                </Td>
                                <Td px={3} py={2} isNumeric>
                                    <Text fontSize='sm' fontFamily='monospace' color={textColor}>
                                        {formatBytes(f.bytesIn + f.bytesOut)}
                                    </Text>
                                </Td>
                                <Td px={3} py={2} isNumeric>
                                    <Text fontSize='sm' fontFamily='monospace' color={textColor}>
                                        {(f.packetsIn + f.packetsOut).toLocaleString()}
                                    </Text>
                                </Td>
                                <Td px={3} py={2} maxW='250px'>
                                    <Text fontSize='xs' fontFamily='monospace' color={textColor} noOfLines={1}>
                                        {f.egressPolicies}
                                    </Text>
                                </Td>
                                <Td px={3} py={2} maxW='250px'>
                                    <Text fontSize='xs' fontFamily='monospace' color={textColor} noOfLines={1}>
                                        {f.ingressPolicies}
                                    </Text>
                                </Td>
                                <Td px={3} py={2}>
                                    <Text
                                        fontSize='xs' fontFamily='monospace'
                                        color={isStale ? 'gray.600' : 'gray.400'}
                                    >
                                        {formatAge(f.lastSeen)}
                                    </Text>
                                </Td>
                            </Tr>
                        );
                    })}
                </Tbody>
            </Table>
            {sortedFlows.length === 0 && (
                <Flex align='center' justify='center' h='200px' color='gray.500'>
                    <Text fontFamily='monospace'>Waiting for flow data...</Text>
                </Flex>
            )}
        </Box>
    );
};

export default FlowMonitorTable;
