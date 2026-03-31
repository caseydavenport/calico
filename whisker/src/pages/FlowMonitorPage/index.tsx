import React from 'react';
import {
    Box, Flex, Heading, Text, Input, InputGroup, InputLeftElement, Select,
} from '@chakra-ui/react';
import { SearchIcon } from '@chakra-ui/icons';
import FlowMonitorTable from '@/features/flowMonitor/components/FlowMonitorTable';
import api from '@/api';
import { FlowLog as ApiFlowLog } from '@/types/api';
import { FlowLog } from '@/types/render';
import { useQuery } from '@tanstack/react-query';
import { v4 as uuid } from 'uuid';

type FlowsApiResponse = {
    items: ApiFlowLog[];
    total: { totalPages: number };
};

const POLL_INTERVAL = 10000; // 10s

const useFlowsList = () =>
    useQuery({
        queryKey: ['flowMonitor'],
        queryFn: () =>
            api.get<FlowsApiResponse>('flows', {
                queryParams: { startTimeGte: '-300' },
            }),
        select: (data): FlowLog[] =>
            (data?.items || []).map((f) => ({
                ...f,
                id: uuid(),
                start_time: new Date(f.start_time),
                end_time: new Date(f.end_time),
            })),
        refetchInterval: POLL_INTERVAL,
    });

const FlowMonitorPage: React.FC = () => {
    const { data: flows, dataUpdatedAt } = useFlowsList();
    const [searchText, setSearchText] = React.useState('');
    const [actionFilter, setActionFilter] = React.useState('all');

    const filteredFlows = React.useMemo(() => {
        if (!flows) return [];
        let result = flows;

        if (searchText.trim()) {
            const q = searchText.toLowerCase().trim();
            result = result.filter(
                (f) =>
                    f.source_name.toLowerCase().includes(q) ||
                    f.source_namespace.toLowerCase().includes(q) ||
                    f.dest_name.toLowerCase().includes(q) ||
                    f.dest_namespace.toLowerCase().includes(q) ||
                    f.protocol.toLowerCase().includes(q),
            );
        }

        if (actionFilter !== 'all') {
            result = result.filter((f) => f.action === actionFilter);
        }

        return result;
    }, [flows, searchText, actionFilter]);

    const lastUpdated = dataUpdatedAt
        ? new Date(dataUpdatedAt).toLocaleTimeString()
        : '';

    // Count active vs stale
    const activeCount = React.useMemo(() => {
        if (!filteredFlows) return 0;
        const now = Date.now();
        const staleMs = 5 * 60 * 1000;
        return filteredFlows.filter(
            (f) => now - f.end_time.getTime() <= staleMs,
        ).length;
    }, [filteredFlows]);

    return (
        <Flex direction='column' p={4} h='100%'>
            <Flex justify='space-between' align='center' mb={3}>
                <Box>
                    <Heading size='md' color='white'>
                        Flow Monitor
                    </Heading>
                    <Text fontSize='xs' color='gray.500' mt={0.5} fontFamily='monospace'>
                        {filteredFlows.length} flows ({activeCount} active)
                        {lastUpdated && ` · polling every ${POLL_INTERVAL / 1000}s · updated ${lastUpdated}`}
                    </Text>
                </Box>
                <Flex align='center' gap={2}>
                    <Box w='8px' h='8px' borderRadius='full' bg='green.400'
                        animation='pulse 2s infinite'
                        sx={{
                            '@keyframes pulse': {
                                '0%': { opacity: 1 },
                                '50%': { opacity: 0.4 },
                                '100%': { opacity: 1 },
                            },
                        }}
                    />
                    <Text fontSize='xs' color='green.400' fontFamily='monospace'>LIVE</Text>
                </Flex>
            </Flex>

            <Flex gap={3} mb={3} align='center'>
                <InputGroup size='sm' maxW='300px'>
                    <InputLeftElement pointerEvents='none'>
                        <SearchIcon color='gray.500' />
                    </InputLeftElement>
                    <Input
                        placeholder='Filter source, dest, namespace, protocol...'
                        value={searchText}
                        onChange={(e) => setSearchText(e.target.value)}
                        bg='gray.800'
                        borderColor='gray.600'
                        color='white'
                        fontFamily='monospace'
                        fontSize='sm'
                        _placeholder={{ color: 'gray.500' }}
                    />
                </InputGroup>

                <Select
                    size='sm'
                    maxW='140px'
                    value={actionFilter}
                    onChange={(e) => setActionFilter(e.target.value)}
                    bg='gray.800'
                    borderColor='gray.600'
                    color='white'
                    fontFamily='monospace'
                    fontSize='sm'
                >
                    <option value='all'>All actions</option>
                    <option value='Allow'>Allow</option>
                    <option value='Deny'>Deny</option>
                </Select>
            </Flex>

            <Box
                bg='gray.900'
                borderRadius='lg'
                border='1px solid'
                borderColor='gray.700'
                flex={1}
                overflow='hidden'
            >
                <FlowMonitorTable flows={filteredFlows} />
            </Box>
        </Flex>
    );
};

export default FlowMonitorPage;
