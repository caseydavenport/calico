import React from 'react';
import { Box, Flex, Heading, Text, Button, ButtonGroup } from '@chakra-ui/react';
import PolicySankeyDiagram from '@/features/policyFlows/components/PolicySankeyDiagram';
import { useFlowLogs } from '@/features/flowLogs/api';

const PolicyFlowsPage: React.FC = () => {
    const [metric, setMetric] = React.useState<'bytes' | 'packets'>('bytes');
    const [showPending, setShowPending] = React.useState(false);
    const { data: flows, isLoading } = useFlowLogs();

    return (
        <Box p={4} h='100%'>
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
                    <PolicySankeyDiagram
                        flows={flows || []}
                        width={1200}
                        height={550}
                        metric={metric}
                        showPending={showPending}
                    />
                )}
            </Box>
        </Box>
    );
};

export default PolicyFlowsPage;
