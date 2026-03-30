import React from 'react';
import {
    Box, Flex, Heading, Text, Button, ButtonGroup,
    Input, InputGroup, InputLeftElement, Select,
} from '@chakra-ui/react';
import { SearchIcon } from '@chakra-ui/icons';
import DualSankeyDiagram from '@/features/policyFlows/components/DualSankeyDiagram';
import api from '@/api';
import { FlowLog as ApiFlowLog } from '@/types/api';
import { FlowLog } from '@/types/render';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
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
    { label: 'Last 1 hour', value: -3600 },
] as const;

const useFlowsList = (startTimeGte: number) =>
    useQuery({
        queryKey: ['flowsList', startTimeGte],
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

const AutoSizeDualSankey: React.FC<{
    flows: FlowLog[];
    metric: 'bytes' | 'packets';
    showPending: boolean;
    onFlowSelect: (sn: string, sns: string, dn: string, dns: string) => void;
}> = (props) => {
    const ref = React.useRef<HTMLDivElement>(null);
    const [dims, setDims] = React.useState({ width: 1400, height: 700 });

    React.useEffect(() => {
        const update = () => {
            if (ref.current) {
                setDims({
                    width: ref.current.clientWidth,
                    height: Math.max(ref.current.clientHeight, 500),
                });
            }
        };
        update();
        window.addEventListener('resize', update);
        return () => window.removeEventListener('resize', update);
    }, []);

    return (
        <Box ref={ref} w='100%' h='100%' minH='500px'>
            <DualSankeyDiagram
                {...props}
                width={dims.width}
                height={dims.height}
            />
        </Box>
    );
};

const PolicyFlowsPage: React.FC = () => {
    const [metric, setMetric] = React.useState<'bytes' | 'packets'>('bytes');
    const [showPending, setShowPending] = React.useState(false);
    const [timeRange, setTimeRange] = React.useState(-300);
    const [searchText, setSearchText] = React.useState('');
    const [actionFilter, setActionFilter] = React.useState<string>('all');
    const navigate = useNavigate();
    const { data: flows, isLoading, dataUpdatedAt } = useFlowsList(timeRange);

    // Client-side filtering
    const filteredFlows = React.useMemo(() => {
        if (!flows) return [];
        let result = flows;

        // Text filter: match against source/dest name or namespace
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

        // Action filter
        if (actionFilter !== 'all') {
            result = result.filter((f) => f.action === actionFilter);
        }

        return result;
    }, [flows, searchText, actionFilter]);

    const handleFlowSelect = React.useCallback(
        (sourceName: string, sourceNamespace: string, destName: string, destNamespace: string) => {
            const params = new URLSearchParams();
            params.set('src', `${sourceNamespace}/${sourceName}`);
            params.set('dst', `${destNamespace}/${destName}`);
            navigate(`/topology?${params.toString()}`);
        },
        [navigate],
    );

    const lastUpdated = dataUpdatedAt
        ? new Date(dataUpdatedAt).toLocaleTimeString()
        : '';

    return (
        <Flex direction='column' p={4} h='100%'>
            {/* Header row */}
            <Flex justify='space-between' align='center' mb={3}>
                <Box>
                    <Heading size='md' color='white'>
                        Policy Flow Visualization
                    </Heading>
                    <Text fontSize='xs' color='gray.500' mt={0.5}>
                        {filteredFlows.length} flows
                        {flows && filteredFlows.length !== flows.length && ` (${flows.length} total)`}
                        {lastUpdated && ` · updated ${lastUpdated}`}
                    </Text>
                </Box>
                <Flex gap={3} align='center'>
                    <ButtonGroup size='sm' isAttached variant='outline'>
                        <Button
                            onClick={() => setMetric('bytes')}
                            colorScheme={metric === 'bytes' ? 'blue' : 'gray'}
                            variant={metric === 'bytes' ? 'solid' : 'outline'}
                        >
                            Bytes
                        </Button>
                        <Button
                            onClick={() => setMetric('packets')}
                            colorScheme={metric === 'packets' ? 'blue' : 'gray'}
                            variant={metric === 'packets' ? 'solid' : 'outline'}
                        >
                            Packets
                        </Button>
                    </ButtonGroup>
                    <Button
                        size='sm'
                        variant={showPending ? 'solid' : 'outline'}
                        colorScheme={showPending ? 'purple' : 'gray'}
                        onClick={() => setShowPending(!showPending)}
                    >
                        {showPending ? 'Staged On' : 'Staged'}
                    </Button>
                </Flex>
            </Flex>

            {/* Filter row */}
            <Flex gap={3} mb={3} align='center'>
                <InputGroup size='sm' maxW='300px'>
                    <InputLeftElement pointerEvents='none'>
                        <SearchIcon color='gray.500' />
                    </InputLeftElement>
                    <Input
                        placeholder='Filter by source, dest, namespace...'
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
                    <option value='Pass'>Pass</option>
                </Select>

                <Select
                    size='sm'
                    maxW='150px'
                    value={timeRange}
                    onChange={(e) => setTimeRange(Number(e.target.value))}
                    bg='gray.800'
                    borderColor='gray.600'
                    color='white'
                    fontFamily='monospace'
                    fontSize='sm'
                >
                    {TIME_RANGES.map((tr) => (
                        <option key={tr.value} value={tr.value}>
                            {tr.label}
                        </option>
                    ))}
                </Select>
            </Flex>

            {/* Chart */}
            <Box
                bg='gray.900'
                borderRadius='lg'
                border='1px solid'
                borderColor='gray.700'
                overflowX='hidden'
                overflowY='auto'
                flex={1}
            >
                {isLoading ? (
                    <Flex align='center' justify='center' h='500px' color='gray.500'>
                        <Text>Loading flow data...</Text>
                    </Flex>
                ) : filteredFlows.length === 0 ? (
                    <Flex align='center' justify='center' h='500px' color='gray.500'>
                        <Text>
                            {flows && flows.length > 0
                                ? 'No flows match the current filters.'
                                : 'No flow data available.'}
                        </Text>
                    </Flex>
                ) : (
                    <AutoSizeDualSankey
                        flows={filteredFlows}
                        metric={metric}
                        showPending={showPending}
                        onFlowSelect={handleFlowSelect}
                    />
                )}
            </Box>
        </Flex>
    );
};

export default PolicyFlowsPage;
