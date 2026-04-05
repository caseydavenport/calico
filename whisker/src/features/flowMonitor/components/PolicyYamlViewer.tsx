import React from 'react';
import ReactDOM from 'react-dom';
import { Box, Flex, Text, Spinner } from '@chakra-ui/react';
import api from '@/api';

type Props = {
    kind: string;
    name: string;
    namespace: string;
    tier: string;
    ruleIndex?: number;
    onClose: () => void;
};

type PolicyApiResponse = {
    items: Array<{
        kind: string;
        name: string;
        namespace: string;
        tier: string;
        yaml: string;
    }>;
};

const ACTION_KEYWORDS = ['Allow', 'Deny', 'Pass', 'Log'];

const PolicyYamlViewer: React.FC<Props> = ({ kind, name, namespace, tier, ruleIndex, onClose }) => {
    const [yaml, setYaml] = React.useState<string | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(true);

    React.useEffect(() => {
        setLoading(true);
        setError(null);
        const params: Record<string, string> = { kind, name };
        if (namespace) params.namespace = namespace;
        if (tier) params.tier = tier;

        api.get<PolicyApiResponse>('policy', { queryParams: params })
            .then((data) => {
                if (data.items && data.items.length > 0) {
                    setYaml(data.items[0].yaml);
                } else {
                    setError('No policy data returned.');
                }
            })
            .catch((err) => {
                setError(err?.data?.error || 'Failed to fetch policy.');
            })
            .finally(() => setLoading(false));
    }, [kind, name, namespace, tier]);

    // Highlight the specific rule in the YAML by finding the rule_index-th
    // rule block under "ingress:" or "egress:".
    const highlightedYaml = React.useMemo(() => {
        if (!yaml || ruleIndex === undefined || ruleIndex < 0) return null;

        const lines = yaml.split('\n');
        let highlightStart = -1;
        let highlightEnd = -1;

        // Find the ingress: or egress: section under spec:.
        // These are at exactly 2-space indent: "  ingress:" or "  egress:".
        // Rules within are list items at 2-space indent: "  - action: ..."
        let inRulesSection = false;
        let rulesSectionIndent = -1;
        let ruleCount = -1;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const indent = line.length - line.trimStart().length;
            const trimmed = line.trimStart();

            // Detect "  ingress:" or "  egress:" (spec-level keys)
            if (/^(ingress|egress):$/.test(trimmed) && indent >= 2) {
                inRulesSection = true;
                rulesSectionIndent = indent;
                ruleCount = -1;
                continue;
            }

            // If we're in a rules section, check if we've left it
            // (a line at the same or lesser indent that isn't a list item)
            if (inRulesSection && trimmed.length > 0 && indent <= rulesSectionIndent && !trimmed.startsWith('- ')) {
                inRulesSection = false;
            }

            // Count list items at exactly rulesSectionIndent (the "- action:" lines)
            if (inRulesSection && trimmed.startsWith('- ') && indent === rulesSectionIndent) {
                ruleCount++;
                if (ruleCount === ruleIndex) {
                    highlightStart = i;
                } else if (highlightStart >= 0 && highlightEnd < 0) {
                    highlightEnd = i;
                }
            }
        }

        if (highlightStart >= 0 && highlightEnd < 0) {
            // Find where this rule block ends (next line at same or lesser indent, or EOF)
            for (let i = highlightStart + 1; i < lines.length; i++) {
                const line = lines[i];
                const trimmed = line.trimStart();
                const indent = line.length - line.trimStart().length;
                if (trimmed.length > 0 && indent <= rulesSectionIndent) {
                    highlightEnd = i;
                    break;
                }
            }
            if (highlightEnd < 0) highlightEnd = lines.length;
        }

        return { highlightStart, highlightEnd };
    }, [yaml, ruleIndex]);

    const content = (
        <Box
            position='fixed'
            top='10vh' left='50%'
            transform='translateX(-50%)'
            bg='gray.900'
            border='1px solid'
            borderColor='gray.600'
            borderRadius='lg'
            boxShadow='0 20px 60px rgba(0,0,0,0.6)'
            zIndex={20000}
            maxW='700px'
            w='90vw'
            maxH='80vh'
            display='flex'
            flexDirection='column'
            overflow='hidden'
        >
            {/* Header */}
            <Flex
                justify='space-between'
                align='center'
                px={4} py={3}
                borderBottom='1px solid'
                borderBottomColor='gray.700'
                bg='gray.800'
            >
                <Box>
                    <Text color='white' fontWeight='bold' fontSize='sm' fontFamily='monospace'>
                        {kind}: {namespace ? `${namespace}/` : ''}{name}
                    </Text>
                    <Text color='gray.400' fontSize='xs' fontFamily='monospace'>
                        {tier ? `Tier: ${tier}` : ''}
                        {ruleIndex !== undefined ? ` · Rule #${ruleIndex}` : ''}
                    </Text>
                </Box>
                <Text
                    color='gray.500' fontSize='sm' cursor='pointer'
                    onClick={onClose} _hover={{ color: 'white' }} px={2}
                >
                    ✕
                </Text>
            </Flex>

            {/* Body */}
            <Box overflowY='auto' flex={1} px={0} py={0}>
                {loading && (
                    <Flex align='center' justify='center' h='100px'>
                        <Spinner color='blue.400' size='sm' mr={2} />
                        <Text color='gray.400' fontSize='sm' fontFamily='monospace'>Loading policy...</Text>
                    </Flex>
                )}
                {error && (
                    <Box px={4} py={3}>
                        <Text color='red.400' fontSize='sm' fontFamily='monospace'>{error}</Text>
                    </Box>
                )}
                {yaml && !loading && (
                    <Box as='pre' fontSize='xs' fontFamily='monospace' m={0} p={0}>
                        {yaml.split('\n').map((line, i) => {
                            const isHighlighted = highlightedYaml &&
                                i >= highlightedYaml.highlightStart &&
                                i < highlightedYaml.highlightEnd;

                            // Simple syntax coloring
                            let color = '#CBD5E0';
                            if (/^\s*#/.test(line)) color = '#718096';
                            else if (/^\s*\w+:/.test(line)) color = '#63B3ED';
                            else if (ACTION_KEYWORDS.some((kw) => line.includes(kw))) color = '#68D391';
                            else if (/:\s*\d+/.test(line)) color = '#F6AD55';

                            return (
                                <Box
                                    key={i}
                                    px={4}
                                    py='1px'
                                    bg={isHighlighted ? 'rgba(99, 179, 237, 0.15)' : undefined}
                                    borderLeft={isHighlighted ? '3px solid #63B3ED' : '3px solid transparent'}
                                >
                                    <Text
                                        as='span'
                                        color='gray.600'
                                        display='inline-block'
                                        w='30px'
                                        textAlign='right'
                                        mr={3}
                                        userSelect='none'
                                        fontSize='10px'
                                    >
                                        {i + 1}
                                    </Text>
                                    <Text as='span' color={color}>
                                        {line || ' '}
                                    </Text>
                                </Box>
                            );
                        })}
                    </Box>
                )}
            </Box>
        </Box>
    );

    // Backdrop + portal
    return ReactDOM.createPortal(
        <>
            <Box
                position='fixed' top={0} left={0} right={0} bottom={0}
                bg='rgba(0,0,0,0.5)' zIndex={19999}
                onClick={onClose}
            />
            {content}
        </>,
        document.body,
    );
};

export default PolicyYamlViewer;
