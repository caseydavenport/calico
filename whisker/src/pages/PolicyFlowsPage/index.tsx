import React from 'react';
import { Box, Flex, Heading, Text, Button, ButtonGroup } from '@chakra-ui/react';
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

const useFlowsList = () =>
    useQuery({
        queryKey: ['flowsList'],
        queryFn: () => api.get<FlowsApiResponse>('flows'),
        select: (data): FlowLog[] =>
            (data?.items || []).map((f) => ({
                ...f,
                id: uuid(),
                start_time: new Date(f.start_time),
                end_time: new Date(f.end_time),
            })),
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
    const navigate = useNavigate();
    const { data: flows, isLoading } = useFlowsList();

    const handleFlowSelect = React.useCallback(
        (sourceName: string, sourceNamespace: string, destName: string, destNamespace: string) => {
            const params = new URLSearchParams();
            params.set('src', `${sourceNamespace}/${sourceName}`);
            params.set('dst', `${destNamespace}/${destName}`);
            navigate(`/topology?${params.toString()}`);
        },
        [navigate],
    );

    return (
        <Flex direction='column' p={4} h='100%'>
            <Flex justify='space-between' align='center' mb={4}>
                <Box>
                    <Heading size='md' color='white'>
                        Policy Flow Visualization
                    </Heading>
                    <Text fontSize='sm' color='gray.400' mt={1}>
                        Traffic volume through policy evaluation tiers
                    </Text>
                </Box>
                <Flex gap={3} align='center'>
                    <ButtonGroup size='sm' isAttached variant='outline'>
                        <Button
                            onClick={() => setMetric('bytes')}
                            colorScheme={
                                metric === 'bytes' ? 'blue' : 'gray'
                            }
                            variant={
                                metric === 'bytes' ? 'solid' : 'outline'
                            }
                        >
                            Bytes
                        </Button>
                        <Button
                            onClick={() => setMetric('packets')}
                            colorScheme={
                                metric === 'packets' ? 'blue' : 'gray'
                            }
                            variant={
                                metric === 'packets' ? 'solid' : 'outline'
                            }
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
                        {showPending ? 'Staged Overlay On' : 'Staged Overlay'}
                    </Button>
                </Flex>
            </Flex>

            <Box
                bg='gray.900'
                borderRadius='lg'
                border='1px solid'
                borderColor='gray.700'
                overflow='hidden'
                flex={1}
            >
                {isLoading ? (
                    <Flex
                        align='center'
                        justify='center'
                        h='500px'
                        color='gray.500'
                    >
                        <Text>Loading flow data...</Text>
                    </Flex>
                ) : (
                    <AutoSizeDualSankey
                        flows={flows || []}
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
