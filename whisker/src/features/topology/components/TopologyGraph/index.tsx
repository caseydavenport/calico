import React from 'react';
import * as d3 from 'd3';
import {
    buildTopologyGraph,
    formatBytes,
    TopologyNode,
    TopologyEdge,
} from '../../utils/buildTopologyGraph';
import { FlowLog } from '@/types/render';
import { Box, Text, Flex, Table, Thead, Tbody, Tr, Th, Td } from '@chakra-ui/react';
import { AnimatePresence, motion } from 'framer-motion';

const MotionBox = motion(Box);

type Props = {
    flows: FlowLog[];
    width?: number;
    height?: number;
    highlightSrc?: string;
    highlightDst?: string;
};

type SimNode = TopologyNode & d3.SimulationNodeDatum;
type SimEdge = Omit<TopologyEdge, 'source' | 'target'> & {
    source: SimNode;
    target: SimNode;
};

const ACTION_COLORS: Record<string, string> = {
    Allow: '#38A169',
    Deny: '#E53E3E',
    Pass: '#3182CE',
    Mixed: '#D69E2E',
};

const NAMESPACE_COLORS = [
    '#2B6CB0', '#38A169', '#D69E2E', '#9F7AEA',
    '#ED64A6', '#DD6B20', '#319795', '#E53E3E',
];

const EXTERNAL_COLOR = '#718096';

const cleanName = (name: string) =>
    name.replace(/-[a-z0-9]{6,10}-\*$/, '-*');

const TopologyGraph: React.FC<Props> = ({
    flows,
    width = 900,
    height = 600,
    highlightSrc,
    highlightDst,
}) => {
    const svgRef = React.useRef<SVGSVGElement>(null);
    const [nodes, setNodes] = React.useState<SimNode[]>([]);
    const [edges, setEdges] = React.useState<SimEdge[]>([]);
    const [hoveredNode, setHoveredNode] = React.useState<string | null>(null);
    const [selectedNode, setSelectedNode] = React.useState<string | null>(null);
    const [tooltipContent, setTooltipContent] = React.useState('');
    const [tooltipPos, setTooltipPos] = React.useState({ x: 0, y: 0 });
    const [transform, setTransform] = React.useState(d3.zoomIdentity);
    const transformRef = React.useRef(d3.zoomIdentity);
    const [collapsedNs, setCollapsedNs] = React.useState(new Set<string>());
    const simulationRef = React.useRef<d3.Simulation<SimNode, SimEdge>>();
    const dragRef = React.useRef<{
        ns: string;
        startX: number;
        startY: number;
        nodeStarts: Map<string, { x: number; y: number }>;
    } | null>(null);

    const toggleNsCollapse = React.useCallback((ns: string) => {
        setCollapsedNs((prev) => {
            const next = new Set(prev);
            if (next.has(ns)) next.delete(ns);
            else next.add(ns);
            return next;
        });
    }, []);

    const rawGraph = React.useMemo(
        () => buildTopologyGraph(flows || []),
        [flows],
    );

    // Apply namespace collapsing: replace all nodes in a collapsed namespace
    // with a single group node, merge edges accordingly.
    const graph = React.useMemo(() => {
        if (collapsedNs.size === 0) return rawGraph;

        const groupNodes = new Map<string, TopologyNode>();
        const keptNodes: TopologyNode[] = [];

        for (const n of rawGraph.nodes) {
            if (collapsedNs.has(n.namespace)) {
                const groupId = `_group_/${n.namespace}`;
                const existing = groupNodes.get(groupId);
                if (existing) {
                    existing.totalBytes += n.totalBytes;
                } else {
                    groupNodes.set(groupId, {
                        id: groupId,
                        name: n.namespace,
                        namespace: n.namespace,
                        totalBytes: n.totalBytes,
                        type: 'workload',
                    });
                }
            } else {
                keptNodes.push(n);
            }
        }

        const allNodes = [...keptNodes, ...groupNodes.values()];
        const nodeIdMap = new Map<string, string>();
        for (const n of rawGraph.nodes) {
            if (collapsedNs.has(n.namespace)) {
                nodeIdMap.set(n.id, `_group_/${n.namespace}`);
            } else {
                nodeIdMap.set(n.id, n.id);
            }
        }

        // Merge edges
        const edgeMap = new Map<string, TopologyEdge>();
        for (const e of rawGraph.edges) {
            const src = nodeIdMap.get(e.source) || e.source;
            const dst = nodeIdMap.get(e.target) || e.target;
            if (src === dst) continue; // skip intra-namespace edges when collapsed
            const key = `${src}->${dst}`;
            const existing = edgeMap.get(key);
            if (existing) {
                existing.bytes += e.bytes;
                existing.packets += e.packets;
                if (existing.action !== e.action) existing.action = 'Mixed';
            } else {
                edgeMap.set(key, { ...e, id: key, source: src, target: dst });
            }
        }

        return { nodes: allNodes, edges: Array.from(edgeMap.values()) };
    }, [rawGraph, collapsedNs]);

    // Namespace color map
    const nsColors = React.useMemo(() => {
        if (!graph || graph.nodes.length === 0) return new Map<string, string>();
        const namespaces = [...new Set(graph.nodes.map((n) => n.namespace))];
        const colorMap = new Map<string, string>();
        namespaces.forEach((ns, i) => {
            colorMap.set(ns, NAMESPACE_COLORS[i % NAMESPACE_COLORS.length]);
        });
        return colorMap;
    }, [graph]);

    const maxBytes = React.useMemo(
        () =>
            graph && graph.edges.length > 0
                ? Math.max(...graph.edges.map((e) => e.bytes), 1)
                : 1,
        [graph],
    );

    // Selected node flows
    const selectedFlows = React.useMemo(() => {
        if (!selectedNode || !flows) return [];
        return flows.filter((f) => {
            const srcId = `${f.source_namespace || '_external_'}/${f.source_name}`;
            const dstId = `${f.dest_namespace || '_external_'}/${f.dest_name}`;
            return srcId === selectedNode || dstId === selectedNode;
        });
    }, [selectedNode, flows]);

    // D3 simulation — preserve positions, only reheat gently on data updates
    const prevNodesRef = React.useRef(new Map<string, { x: number; y: number }>());
    const isFirstRender = React.useRef(true);

    React.useEffect(() => {
        if (graph.nodes.length === 0) return;

        const prev = prevNodesRef.current;
        const hasExisting = prev.size > 0;
        const simNodes: SimNode[] = graph.nodes.map((n) => {
            const saved = prev.get(n.id);
            return {
                ...n,
                x: saved?.x ?? width / 2 + (Math.random() - 0.5) * 300,
                y: saved?.y ?? height / 2 + (Math.random() - 0.5) * 300,
                // Pin existing nodes so they don't bounce
                ...(saved && hasExisting && !isFirstRender.current ? { fx: saved.x, fy: saved.y } : {}),
            };
        });

        const nodeMap = new Map(simNodes.map((n) => [n.id, n]));
        const simEdges: SimEdge[] = graph.edges
            .map((e) => ({
                ...e,
                source: nodeMap.get(e.source)!,
                target: nodeMap.get(e.target)!,
            }))
            .filter((e) => e.source && e.target);

        // Namespace bounding box separation force
        const nsSeparation = () => {
            const nsBounds = new Map<string, { minX: number; maxX: number; minY: number; maxY: number; nodes: SimNode[] }>();
            for (const n of simNodes) {
                const ns = n.namespace;
                const b = nsBounds.get(ns) || { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, nodes: [] };
                b.minX = Math.min(b.minX, n.x! - 40);
                b.maxX = Math.max(b.maxX, n.x! + 40);
                b.minY = Math.min(b.minY, n.y! - 40);
                b.maxY = Math.max(b.maxY, n.y! + 40);
                b.nodes.push(n);
                nsBounds.set(ns, b);
            }

            // Push apart overlapping namespace bounding boxes
            const entries = Array.from(nsBounds.entries());
            for (let i = 0; i < entries.length; i++) {
                for (let j = i + 1; j < entries.length; j++) {
                    const [, a] = entries[i];
                    const [, b] = entries[j];
                    const pad = 30;
                    const overlapX = Math.min(a.maxX + pad, b.maxX + pad) - Math.max(a.minX - pad, b.minX - pad);
                    const overlapY = Math.min(a.maxY + pad, b.maxY + pad) - Math.max(a.minY - pad, b.minY - pad);

                    if (overlapX > 0 && overlapY > 0) {
                        const acx = (a.minX + a.maxX) / 2;
                        const acy = (a.minY + a.maxY) / 2;
                        const bcx = (b.minX + b.maxX) / 2;
                        const bcy = (b.minY + b.maxY) / 2;
                        const dx = bcx - acx || 0.1;
                        const dy = bcy - acy || 0.1;
                        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                        const force = Math.min(overlapX, overlapY) * 0.02;

                        for (const n of a.nodes) {
                            n.vx! -= (dx / dist) * force;
                            n.vy! -= (dy / dist) * force;
                        }
                        for (const n of b.nodes) {
                            n.vx! += (dx / dist) * force;
                            n.vy! += (dy / dist) * force;
                        }
                    }
                }
            }

            // Cluster nodes within same namespace
            for (const [, b] of nsBounds) {
                if (b.nodes.length < 2) continue;
                const cx = b.nodes.reduce((s, n) => s + n.x!, 0) / b.nodes.length;
                const cy = b.nodes.reduce((s, n) => s + n.y!, 0) / b.nodes.length;
                for (const n of b.nodes) {
                    n.vx! += (cx - n.x!) * 0.008;
                    n.vy! += (cy - n.y!) * 0.008;
                }
            }

            // Boundary force: keep nodes within viewport with soft padding
            const margin = 80;
            for (const n of simNodes) {
                if (n.x! < margin) n.vx! += (margin - n.x!) * 0.05;
                if (n.x! > width - margin) n.vx! -= (n.x! - (width - margin)) * 0.05;
                if (n.y! < margin) n.vy! += (margin - n.y!) * 0.05;
                if (n.y! > height - margin) n.vy! -= (n.y! - (height - margin)) * 0.05;
            }
        };

        const simulation = d3
            .forceSimulation<SimNode>(simNodes)
            .force('link', d3.forceLink<SimNode, SimEdge>(simEdges).id((d) => d.id).distance(120))
            .force('charge', d3.forceManyBody().strength(-400))
            .force('center', d3.forceCenter(width / 2, height / 2))
            .force('collision', d3.forceCollide().radius(40))
            .force('nsSeparation', nsSeparation)
            // On data refresh, only apply a tiny nudge instead of full reheat
            .alpha(isFirstRender.current ? 1 : 0.05)
            .alphaDecay(0.03);

        simulationRef.current = simulation;
        isFirstRender.current = false;

        // After a short settle, unpin existing nodes so they can adjust
        if (hasExisting) {
            setTimeout(() => {
                for (const n of simNodes) {
                    n.fx = undefined;
                    n.fy = undefined;
                }
            }, 500);
        }

        simulation.on('tick', () => {
            for (const n of simNodes) {
                prevNodesRef.current.set(n.id, { x: n.x!, y: n.y! });
            }
            setNodes([...simNodes]);
            setEdges([...simEdges]);
        });

        return () => { simulation.stop(); };
    }, [graph, width, height]);

    // Zoom
    React.useEffect(() => {
        if (!svgRef.current) return;
        const svg = svgRef.current;

        const zoom = d3.zoom<SVGSVGElement, unknown>()
            .scaleExtent([0.2, 4])
            .filter((event) => {
                // Don't start zoom drag on namespace hulls or nodes
                const target = event.target as SVGElement;
                if (target.closest('[data-ns-drag]') || target.closest('[data-node-id]')) {
                    return event.type === 'wheel'; // still allow scroll-zoom
                }
                return true;
            })
            .on('zoom', (event) => {
                setTransform(event.transform);
                transformRef.current = event.transform;
            });

        d3.select(svg).call(zoom);

        // Click handler for node selection
        const handleClick = (e: MouseEvent) => {
            if (dragRef.current) return; // don't select during drag
            const target = e.target as SVGElement;
            const nodeId = target.closest('[data-node-id]')?.getAttribute('data-node-id');
            if (nodeId) {
                setSelectedNode((prev) => prev === nodeId ? null : nodeId);
            } else if (target === svg || (target.tagName === 'rect' && !target.closest('[data-ns-drag]'))) {
                setSelectedNode(null);
            }
        };
        svg.addEventListener('click', handleClick);

        // Namespace drag handlers
        const handlePointerDown = (e: PointerEvent) => {
            const target = e.target as SVGElement;
            const nsEl = target.closest('[data-ns-drag]');
            if (!nsEl) return;
            const ns = nsEl.getAttribute('data-ns-drag')!;

            // Collect starting positions of all nodes in this namespace
            const nodeStarts = new Map<string, { x: number; y: number }>();
            for (const [id, pos] of prevNodesRef.current) {
                if (id.startsWith(`${ns}/`) || id.startsWith(`_group_/${ns}`)) {
                    nodeStarts.set(id, { ...pos });
                }
            }

            // Transform pointer to SVG coordinates
            const pt = svg.createSVGPoint();
            pt.x = e.clientX;
            pt.y = e.clientY;
            const svgPt = pt.matrixTransform(svg.getScreenCTM()!.inverse());

            dragRef.current = {
                ns,
                startX: svgPt.x,
                startY: svgPt.y,
                nodeStarts,
            };

            // Pin all nodes in the namespace
            if (simulationRef.current) {
                for (const node of simulationRef.current.nodes()) {
                    if (nodeStarts.has(node.id)) {
                        node.fx = node.x;
                        node.fy = node.y;
                    }
                }
                simulationRef.current.alphaTarget(0.1).restart();
            }

            (e.target as Element).setPointerCapture(e.pointerId);
            e.stopPropagation();
        };

        const handlePointerMove = (e: PointerEvent) => {
            if (!dragRef.current) return;
            const { nodeStarts, startX, startY } = dragRef.current;

            const pt = svg.createSVGPoint();
            pt.x = e.clientX;
            pt.y = e.clientY;
            const svgPt = pt.matrixTransform(svg.getScreenCTM()!.inverse());

            // Account for current zoom transform
            const k = transformRef.current.k;
            const dx = (svgPt.x - startX) / k;
            const dy = (svgPt.y - startY) / k;

            if (simulationRef.current) {
                for (const node of simulationRef.current.nodes()) {
                    const start = nodeStarts.get(node.id);
                    if (start) {
                        node.fx = start.x + dx;
                        node.fy = start.y + dy;
                    }
                }
            }
        };

        const handlePointerUp = () => {
            if (!dragRef.current) return;
            const { nodeStarts } = dragRef.current;

            // Unpin nodes, save new positions
            if (simulationRef.current) {
                for (const node of simulationRef.current.nodes()) {
                    if (nodeStarts.has(node.id)) {
                        prevNodesRef.current.set(node.id, { x: node.x!, y: node.y! });
                        node.fx = undefined;
                        node.fy = undefined;
                    }
                }
                simulationRef.current.alphaTarget(0);
            }

            dragRef.current = null;
        };

        svg.addEventListener('pointerdown', handlePointerDown);
        svg.addEventListener('pointermove', handlePointerMove);
        svg.addEventListener('pointerup', handlePointerUp);

        return () => {
            svg.removeEventListener('click', handleClick);
            svg.removeEventListener('pointerdown', handlePointerDown);
            svg.removeEventListener('pointermove', handlePointerMove);
            svg.removeEventListener('pointerup', handlePointerUp);
        };
    }, []);

    // Auto-select from highlight params
    const didAutoSelect = React.useRef(false);
    React.useEffect(() => {
        if (didAutoSelect.current || !highlightSrc || nodes.length === 0) return;
        const node = nodes.find((n) => n.id === highlightSrc);
        if (node) {
            setSelectedNode(node.id);
            didAutoSelect.current = true;
        }
    }, [nodes, highlightSrc, highlightDst]);

    // Rendering helpers
    const nodeRadius = (node: SimNode) => {
        const minR = 10;
        const maxR = 30;
        const maxNodeBytes = Math.max(...nodes.map((n) => n.totalBytes), 1);
        return minR + (node.totalBytes / maxNodeBytes) * (maxR - minR);
    };

    const edgeWidth = (edge: SimEdge) =>
        Math.max(1.5, (edge.bytes / maxBytes) * 8);

    if (graph.nodes.length === 0) {
        return (
            <Flex align='center' justify='center' h={height} color='gray.500'>
                <Text fontFamily='monospace'>No flow data available.</Text>
            </Flex>
        );
    }

    const activeNode = hoveredNode || selectedNode;

    const isNodeHighlighted = (nodeId: string) => {
        if (!activeNode) return true;
        if (nodeId === activeNode) return true;
        return edges.some(
            (e) =>
                (e.source.id === activeNode && e.target.id === nodeId) ||
                (e.target.id === activeNode && e.source.id === nodeId),
        );
    };

    const isEdgeHighlighted = (edge: SimEdge) => {
        if (!activeNode) return true;
        return edge.source.id === activeNode || edge.target.id === activeNode;
    };

    const selectedNodeObj = nodes.find((n) => n.id === selectedNode);

    // Curved edge path
    const edgePath = (edge: SimEdge) => {
        const dx = edge.target.x! - edge.source.x!;
        const dy = edge.target.y! - edge.source.y!;
        const dr = Math.sqrt(dx * dx + dy * dy) * 1.5;
        return `M${edge.source.x},${edge.source.y} A${dr},${dr} 0 0,1 ${edge.target.x},${edge.target.y}`;
    };

    // Arrow marker at 60% along edge
    const arrowPos = (edge: SimEdge) => {
        const t = 0.6;
        return {
            x: edge.source.x! + (edge.target.x! - edge.source.x!) * t,
            y: edge.source.y! + (edge.target.y! - edge.source.y!) * t,
        };
    };

    return (
        <Box position='relative' h='100%'>
            <svg
                ref={svgRef}
                width={width}
                height={height}
                style={{ background: '#1A202C' }}
            >
                {/* Background click target */}
                <rect width={width} height={height} fill='transparent' />

                <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
                    {/* Namespace hulls — clickable label to collapse/expand */}
                    {(() => {
                        const nsByNs = new Map<string, SimNode[]>();
                        for (const n of nodes) {
                            if (n.type === 'external') continue;
                            const arr = nsByNs.get(n.namespace) || [];
                            arr.push(n);
                            nsByNs.set(n.namespace, arr);
                        }
                        return Array.from(nsByNs.entries()).map(([ns, nsNodes]) => {
                            const padding = 50;
                            const xs = nsNodes.map((n) => n.x!);
                            const ys = nsNodes.map((n) => n.y!);
                            const x0 = Math.min(...xs) - padding;
                            const y0 = Math.min(...ys) - padding;
                            const x1 = Math.max(...xs) + padding;
                            const y1 = Math.max(...ys) + padding;
                            const color = nsColors.get(ns) || '#4A5568';
                            const isCollapsed = collapsedNs.has(ns);
                            return (
                                <g key={`hull-${ns}`} data-ns-drag={ns}
                                    style={{ cursor: 'grab' }}
                                >
                                    <rect
                                        x={x0} y={y0}
                                        width={x1 - x0} height={y1 - y0}
                                        rx={12}
                                        fill={color}
                                        fillOpacity={isCollapsed ? 0.15 : 0.06}
                                        stroke={color}
                                        strokeOpacity={isCollapsed ? 0.4 : 0.15}
                                        strokeWidth={isCollapsed ? 2 : 1}
                                    />
                                    {/* Clickable namespace label */}
                                    <text
                                        x={x0 + 10} y={y0 + 16}
                                        fontSize={11}
                                        fill={color}
                                        fontFamily='monospace'
                                        fontWeight='bold'
                                        opacity={0.8}
                                        style={{ cursor: 'pointer' }}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            toggleNsCollapse(ns);
                                        }}
                                    >
                                        {isCollapsed ? '▸' : '▾'} {ns}
                                        {isCollapsed && (
                                            <tspan fill='#A0AEC0' fontWeight='normal'>
                                                {' '}({nsNodes.length === 1 ? '1 workload' : `collapsed`})
                                            </tspan>
                                        )}
                                    </text>
                                </g>
                            );
                        });
                    })()}

                    {/* Edges */}
                    <g>
                        {edges.map((edge) => {
                            const highlighted = isEdgeHighlighted(edge);
                            const color = ACTION_COLORS[edge.action] || '#A0AEC0';
                            const w = edgeWidth(edge);
                            return (
                                <g key={edge.id}>
                                    <path
                                        d={edgePath(edge)}
                                        fill='none'
                                        stroke={color}
                                        strokeWidth={w}
                                        strokeOpacity={highlighted ? 0.6 : 0.06}
                                        strokeDasharray={edge.action === 'Deny' ? '6,3' : undefined}
                                        style={{ transition: 'stroke-opacity 0.2s ease' }}
                                    />
                                    {/* Direction indicator */}
                                    <circle
                                        cx={arrowPos(edge).x}
                                        cy={arrowPos(edge).y}
                                        r={Math.max(2, w * 0.6)}
                                        fill={color}
                                        opacity={highlighted ? 0.8 : 0.06}
                                        style={{ transition: 'opacity 0.2s ease' }}
                                    />
                                </g>
                            );
                        })}
                    </g>

                    {/* Nodes */}
                    <g>
                        {nodes.map((node) => {
                            const r = nodeRadius(node);
                            const isExternal = node.type === 'external';
                            const color = isExternal
                                ? EXTERNAL_COLOR
                                : nsColors.get(node.namespace) || '#718096';
                            const highlighted = isNodeHighlighted(node.id);
                            const isSelected = selectedNode === node.id;
                            const isHovered = hoveredNode === node.id;

                            return (
                                <g
                                    key={node.id}
                                    data-node-id={node.id}
                                    transform={`translate(${node.x},${node.y})`}
                                    opacity={highlighted ? 1 : 0.15}
                                    style={{ transition: 'opacity 0.2s ease', cursor: 'pointer' }}
                                    onMouseEnter={(e) => {
                                        setHoveredNode(node.id);
                                        setTooltipContent(
                                            `${node.name}\n${node.namespace}\n${formatBytes(node.totalBytes)}`,
                                        );
                                        setTooltipPos({ x: e.clientX, y: e.clientY });
                                    }}
                                    onMouseLeave={() => {
                                        setHoveredNode(null);
                                        setTooltipContent('');
                                    }}
                                >
                                    {/* External nodes: diamond shape */}
                                    {isExternal ? (
                                        <rect
                                            x={-r * 0.7} y={-r * 0.7}
                                            width={r * 1.4} height={r * 1.4}
                                            rx={4}
                                            transform='rotate(45)'
                                            fill={EXTERNAL_COLOR}
                                            stroke={isSelected || isHovered ? '#FFF' : 'rgba(255,255,255,0.2)'}
                                            strokeWidth={isSelected ? 2.5 : isHovered ? 2 : 1}
                                        />
                                    ) : (
                                        <circle
                                            r={r}
                                            fill={color}
                                            stroke={isSelected || isHovered ? '#FFF' : 'rgba(255,255,255,0.15)'}
                                            strokeWidth={isSelected ? 2.5 : isHovered ? 2 : 1}
                                        />
                                    )}
                                    {/* Node label */}
                                    <text
                                        dy={r + 14}
                                        textAnchor='middle'
                                        fontSize={11}
                                        fill='#E2E8F0'
                                        fontFamily='monospace'
                                        fontWeight={isSelected ? 'bold' : '600'}
                                    >
                                        {cleanName(node.name)}
                                    </text>
                                    <text
                                        dy={r + 25}
                                        textAnchor='middle'
                                        fontSize={9}
                                        fill='#A0AEC0'
                                        fontFamily='monospace'
                                    >
                                        {node.namespace}
                                    </text>
                                </g>
                            );
                        })}
                    </g>
                </g>
            </svg>

            {/* Tooltip */}
            {tooltipContent && (
                <Box
                    position='fixed'
                    left={tooltipPos.x + 14}
                    top={tooltipPos.y - 24}
                    bg='gray.900' color='white' px={3} py={1.5}
                    borderRadius='lg' fontSize='xs' fontFamily='monospace'
                    pointerEvents='none' zIndex={1000} whiteSpace='pre-line'
                    border='1px solid' borderColor='gray.600' boxShadow='lg'
                >
                    {tooltipContent}
                </Box>
            )}

            {/* Legend */}
            <Flex
                position='absolute' bottom={4} left={4}
                bg='rgba(26, 32, 44, 0.9)' borderRadius='md'
                px={3} py={2} gap={4} fontSize='xs' color='gray.300'
                fontFamily='monospace'
            >
                {Object.entries(ACTION_COLORS).map(([action, color]) => (
                    <Flex key={action} align='center' gap={1.5}>
                        <Box w='10px' h='10px' borderRadius={action === 'Mixed' ? 'sm' : 'full'} bg={color} />
                        <Text>{action}</Text>
                    </Flex>
                ))}
                <Flex align='center' gap={1.5}>
                    <Box w='10px' h='10px' borderRadius='sm' bg={EXTERNAL_COLOR} transform='rotate(45deg)' />
                    <Text>External</Text>
                </Flex>
            </Flex>

            {/* Namespace legend */}
            <Flex
                position='absolute' top={4} right={4}
                bg='rgba(26, 32, 44, 0.9)' borderRadius='md'
                px={3} py={2} gap={2} flexDirection='column'
                fontSize='xs' color='gray.300' fontFamily='monospace'
            >
                <Text color='gray.500' fontWeight='bold' fontSize='10px'>NAMESPACES</Text>
                {Array.from(nsColors.entries()).map(([ns, color]) => (
                    <Flex key={ns} align='center' gap={1.5}>
                        <Box w='8px' h='8px' borderRadius='full' bg={color} />
                        <Text>{ns}</Text>
                    </Flex>
                ))}
            </Flex>

            {/* Selected node detail panel */}
            <AnimatePresence>
                {selectedNodeObj && (
                    <MotionBox
                        position='fixed' bottom={0} left={0} right={0}
                        bg='gray.800' borderTop='1px solid' borderColor='gray.600'
                        p={5} maxH='35vh' overflowY='auto'
                        initial={{ y: '100%' }}
                        animate={{ y: 0 }}
                        exit={{ y: '100%' }}
                        transition={{ type: 'spring', damping: 28, stiffness: 300 }}
                        boxShadow='0 -8px 30px rgba(0,0,0,0.5)'
                        zIndex={100}
                    >
                        <Flex justify='space-between' align='center' mb={3}>
                            <Box>
                                <Text color='white' fontWeight='bold' fontSize='md' fontFamily='monospace'>
                                    {cleanName(selectedNodeObj.name)}
                                    <Text as='span' color='gray.400' fontWeight='normal' ml={2}>
                                        {selectedNodeObj.namespace}
                                    </Text>
                                </Text>
                                <Flex gap={4} mt={1} fontSize='sm' color='gray.400' fontFamily='monospace'>
                                    <Text>{formatBytes(selectedNodeObj.totalBytes)} total traffic</Text>
                                    <Text>{selectedFlows.length} flows</Text>
                                </Flex>
                            </Box>
                            <Text
                                color='gray.500' fontSize='sm' cursor='pointer'
                                onClick={() => setSelectedNode(null)}
                                _hover={{ color: 'white' }} px={2}
                            >
                                ✕
                            </Text>
                        </Flex>

                        <Box overflowX='auto'>
                            <Table size='sm' variant='unstyled'>
                                <Thead>
                                    <Tr>
                                        <Th color='gray.500' fontSize='xs' px={2} py={1} fontFamily='monospace' textTransform='none'>Action</Th>
                                        <Th color='gray.500' fontSize='xs' px={2} py={1} fontFamily='monospace' textTransform='none'>Source</Th>
                                        <Th color='gray.500' fontSize='xs' px={2} py={1} fontFamily='monospace' textTransform='none'>Destination</Th>
                                        <Th color='gray.500' fontSize='xs' px={2} py={1} fontFamily='monospace' textTransform='none'>Proto</Th>
                                        <Th color='gray.500' fontSize='xs' px={2} py={1} fontFamily='monospace' textTransform='none'>Port</Th>
                                        <Th color='gray.500' fontSize='xs' px={2} py={1} fontFamily='monospace' textTransform='none'>Reporter</Th>
                                        <Th color='gray.500' fontSize='xs' px={2} py={1} fontFamily='monospace' textTransform='none' isNumeric>Bytes</Th>
                                        <Th color='gray.500' fontSize='xs' px={2} py={1} fontFamily='monospace' textTransform='none' isNumeric>Packets</Th>
                                    </Tr>
                                </Thead>
                                <Tbody>
                                    {selectedFlows.map((f) => {
                                        const bytes =
                                            (typeof f.bytes_in === 'number' ? f.bytes_in : parseInt(f.bytes_in || '0')) +
                                            (typeof f.bytes_out === 'number' ? f.bytes_out : parseInt(f.bytes_out || '0'));
                                        const packets =
                                            (typeof f.packets_in === 'number' ? f.packets_in as number : parseInt(f.packets_in || '0')) +
                                            (typeof f.packets_out === 'number' ? f.packets_out as number : parseInt(f.packets_out || '0'));
                                        const actionColor = ACTION_COLORS[f.action] || 'gray.400';
                                        return (
                                            <Tr key={f.id} _hover={{ bg: 'rgba(255,255,255,0.03)' }}>
                                                <Td px={2} py={1.5}>
                                                    <Flex align='center' gap={1.5}>
                                                        <Box w='8px' h='8px' borderRadius='full' bg={actionColor} />
                                                        <Text fontSize='xs' fontFamily='monospace' fontWeight='bold' color={actionColor}>
                                                            {f.action}
                                                        </Text>
                                                    </Flex>
                                                </Td>
                                                <Td px={2} py={1.5}>
                                                    <Text fontSize='xs' fontFamily='monospace' color='gray.200'>
                                                        {f.source_namespace}/{cleanName(f.source_name)}
                                                    </Text>
                                                </Td>
                                                <Td px={2} py={1.5}>
                                                    <Text fontSize='xs' fontFamily='monospace' color='gray.200'>
                                                        {f.dest_namespace}/{cleanName(f.dest_name)}
                                                    </Text>
                                                </Td>
                                                <Td px={2} py={1.5}>
                                                    <Text fontSize='xs' fontFamily='monospace' color='gray.400'>{f.protocol}</Text>
                                                </Td>
                                                <Td px={2} py={1.5}>
                                                    <Text fontSize='xs' fontFamily='monospace' color='gray.400'>{f.dest_port}</Text>
                                                </Td>
                                                <Td px={2} py={1.5}>
                                                    <Text fontSize='xs' fontFamily='monospace' color='gray.400'>{f.reporter}</Text>
                                                </Td>
                                                <Td px={2} py={1.5} isNumeric>
                                                    <Text fontSize='xs' fontFamily='monospace' color='gray.300'>
                                                        {formatBytes(bytes)}
                                                    </Text>
                                                </Td>
                                                <Td px={2} py={1.5} isNumeric>
                                                    <Text fontSize='xs' fontFamily='monospace' color='gray.300'>
                                                        {packets.toLocaleString()}
                                                    </Text>
                                                </Td>
                                            </Tr>
                                        );
                                    })}
                                </Tbody>
                            </Table>
                        </Box>
                    </MotionBox>
                )}
            </AnimatePresence>
        </Box>
    );
};

export default TopologyGraph;
