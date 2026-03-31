import { Grid, GridItem, Flex, Box, Text } from '@chakra-ui/react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import AppHeader from '../AppHeader';
import { gridStyles } from './styles';
import { PromotionsBanner } from '@/features/promotions/components';

const NAV_ITEMS = [
    { path: '/flow-logs', label: 'Flow Logs' },
    { path: '/monitor', label: 'Flow Monitor' },
    { path: '/policy-flows', label: 'Policy Flows' },
    { path: '/policy-tree', label: 'Policy Tree' },
    { path: '/policy-matrix', label: 'Policy Matrix' },
    { path: '/topology', label: 'Topology' },
];

const AppLayout: React.FC = () => {
    const location = useLocation();
    const navigate = useNavigate();

    return (
        <Grid sx={gridStyles}>
            <GridItem gridArea='promo-banner'>
                <PromotionsBanner />
            </GridItem>
            <GridItem gridArea='header'>
                <AppHeader />
                <Flex
                    bg='tigera-bg'
                    borderBottom='1px solid'
                    borderBottomColor='tigera-color-outline'
                    px={4}
                    gap={0}
                >
                    {NAV_ITEMS.map((item) => {
                        const isActive = location.pathname === item.path;
                        return (
                            <Box
                                key={item.path}
                                px={4}
                                py={2}
                                cursor='pointer'
                                borderBottom='2px solid'
                                borderBottomColor={
                                    isActive
                                        ? 'tigeraGoldMedium'
                                        : 'transparent'
                                }
                                _hover={{
                                    borderBottomColor: isActive
                                        ? 'tigeraGoldMedium'
                                        : 'gray.500',
                                }}
                                onClick={() => navigate(item.path)}
                            >
                                <Text
                                    fontSize='sm'
                                    fontWeight={isActive ? 'bold' : 'medium'}
                                    color={isActive ? 'white' : 'gray.400'}
                                >
                                    {item.label}
                                </Text>
                            </Box>
                        );
                    })}
                </Flex>
            </GridItem>
            <GridItem id='main' gridArea='main' overflowY='auto' height='100%'>
                <Outlet />
            </GridItem>
        </Grid>
    );
};

export default AppLayout;
