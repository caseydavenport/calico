import React from 'react';
import {
    Box, Flex, Heading, Text, Button, ButtonGroup,
    Input, InputGroup, InputLeftElement, Select,
} from '@chakra-ui/react';
import { SearchIcon } from '@chakra-ui/icons';
import PolicyMatrix from '@/features/policyMatrix/components/PolicyMatrix';
import api from '@/api';
import { FlowLog as ApiFlowLog } from '@/types/api';
import { FlowLog } from '@/types/render';
import { useQuery } from '@tanstack/react-query';
import { v4 as uuid } from 'uuid';

type FlowsApiResponse = {
    items: ApiFlowLog[];
    total: { totalPages: number };
};

const TIME_RANGES = [
    { label: 'Last 1 min', value: -60 },
    { label: 'Last 5 min', value: -300 },
    { label: 'Last 15 min', value: -900 },
    { label: 'Last 30 min', value: -1800 },
] as const;

const useFlowsList = (startTimeGte: number) =>
    useQuery({
        queryKey: ['policyMatrixFlows', startTimeGte],
        queryFn: () =>
            api.get<FlowsApiResponse>('flows', {
                queryParams: { startTimeGte: String(startTimeGte) },
            }),
        select: (data): FlowLog[] =>
            (data?.items || []).map((f) => ({
                ...f,
                id: uuid(),
                start_time: new Date(f.start_time),
                end_time: new Date(f.end_time),
            })),
        refetchInterval: 15000,
    });

const PolicyMatrixPage: React.FC = () => {
    const [metric, setMetric] = React.useState<'bytes' | 'packets'>('bytes');
    const [timeRange, setTimeRange] = React.useState(-300);
    const [searchText, setSearchText] = React.useState('');
    const [actionFilter, setActionFilter] = React.useState('all');
    const { data: flows, isLoading, dataUpdatedAt } = useFlowsList(timeRange);

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
                    f.dest_namespace.toLowerCase().includes(q),
            );
        }
        if (actionFilter !== 'all') {
            result = result.filter((f) => f.action === actionFilter);
        }
        return result;
    }, [flows, searchText, actionFilter]);

    const lastUpdated = dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString() : '';

    return (
        <Flex direction='column' p={4} h='100%'>
            <Flex justify='space-between' align='center' mb={3}>
                <Box>
                    <Heading size='md' color='white'>Policy Matrix</Heading>
                    <Text fontSize='xs' color='gray.500' mt={0.5} fontFamily='monospace'>
                        Flows vs policies — which policy decides the fate of each flow
                        {lastUpdated && ` · updated ${lastUpdated}`}
                    </Text>
                </Box>
                <Flex gap={3} align='center'>
                    <ButtonGroup size='sm' isAttached variant='outline'>
                        <Button onClick={() => setMetric('bytes')}
                            colorScheme={metric === 'bytes' ? 'blue' : 'gray'}
                            variant={metric === 'bytes' ? 'solid' : 'outline'}
                        >Bytes</Button>
                        <Button onClick={() => setMetric('packets')}
                            colorScheme={metric === 'packets' ? 'blue' : 'gray'}
                            variant={metric === 'packets' ? 'solid' : 'outline'}
                        >Packets</Button>
                    </ButtonGroup>
                </Flex>
            </Flex>

            <Flex gap={3} mb={3} align='center'>
                <InputGroup size='sm' maxW='300px'>
                    <InputLeftElement pointerEvents='none'>
                        <SearchIcon color='gray.500' />
                    </InputLeftElement>
                    <Input
                        placeholder='Filter source, dest, namespace...'
                        value={searchText} onChange={(e) => setSearchText(e.target.value)}
                        bg='gray.800' borderColor='gray.600' color='white'
                        fontFamily='monospace' fontSize='sm' _placeholder={{ color: 'gray.500' }}
                    />
                </InputGroup>
                <Select size='sm' maxW='140px' value={actionFilter}
                    onChange={(e) => setActionFilter(e.target.value)}
                    bg='gray.800' borderColor='gray.600' color='white' fontFamily='monospace' fontSize='sm'
                >
                    <option value='all'>All actions</option>
                    <option value='Allow'>Allow</option>
                    <option value='Deny'>Deny</option>
                </Select>
                <Select size='sm' maxW='150px' value={timeRange}
                    onChange={(e) => setTimeRange(Number(e.target.value))}
                    bg='gray.800' borderColor='gray.600' color='white' fontFamily='monospace' fontSize='sm'
                >
                    {TIME_RANGES.map((tr) => (
                        <option key={tr.value} value={tr.value}>{tr.label}</option>
                    ))}
                </Select>
            </Flex>

            <Box
                bg='gray.900' borderRadius='lg' border='1px solid' borderColor='gray.700'
                overflow='hidden' flex={1}
            >
                {isLoading ? (
                    <Flex align='center' justify='center' h='100%' color='gray.500'>
                        <Text fontFamily='monospace'>Loading...</Text>
                    </Flex>
                ) : filteredFlows.length === 0 ? (
                    <Flex align='center' justify='center' h='100%' color='gray.500'>
                        <Text fontFamily='monospace'>No flows match filters.</Text>
                    </Flex>
                ) : (
                    <PolicyMatrix flows={filteredFlows} metric={metric} />
                )}
            </Box>
        </Flex>
    );
};

export default PolicyMatrixPage;
