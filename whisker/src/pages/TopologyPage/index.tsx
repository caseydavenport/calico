import React from 'react';
import { Box, Flex, Heading, Text } from '@chakra-ui/react';
import TopologyGraph from '@/features/topology/components/TopologyGraph';
import api from '@/api';
import { FlowLog as ApiFlowLog } from '@/types/api';
import { FlowLog } from '@/types/render';
import { useQuery } from '@tanstack/react-query';
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

const TopologyPage: React.FC = () => {
    const { data: flows, isLoading } = useFlowsList();
    const [dimensions, setDimensions] = React.useState({
        width: 1200,
        height: 700,
    });
    const containerRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        const updateDimensions = () => {
            if (containerRef.current) {
                setDimensions({
                    width: containerRef.current.clientWidth,
                    height: Math.max(
                        containerRef.current.clientHeight - 60,
                        400,
                    ),
                });
            }
        };

        updateDimensions();
        window.addEventListener('resize', updateDimensions);
        return () => window.removeEventListener('resize', updateDimensions);
    }, []);

    return (
        <Box p={4} h='100%' ref={containerRef}>
            <Flex justify='space-between' align='center' mb={4}>
                <Box>
                    <Heading size='md' color='white'>
                        Service Topology
                    </Heading>
                    <Text fontSize='sm' color='gray.400' mt={1}>
                        Network communication graph — drag nodes, scroll to
                        zoom
                    </Text>
                </Box>
                <Text fontSize='xs' color='gray.500'>
                    {flows?.length || 0} flows |{' '}
                    {new Set(
                        flows?.map(
                            (f) => `${f.source_namespace}/${f.source_name}`,
                        ) || [],
                    ).size}{' '}
                    sources
                </Text>
            </Flex>

            <Box
                borderRadius='lg'
                border='1px solid'
                borderColor='gray.700'
                overflow='hidden'
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
                    <TopologyGraph
                        flows={flows || []}
                        width={dimensions.width - 32}
                        height={dimensions.height}
                    />
                )}
            </Box>
        </Box>
    );
};

export default TopologyPage;
