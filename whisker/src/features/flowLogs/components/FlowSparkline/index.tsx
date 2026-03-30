import React from 'react';
import { Box } from '@chakra-ui/react';
import { FlowLog } from '@/types/render';

type SparklinePoint = {
    timestamp: number;
    value: number;
};

type Props = {
    data: SparklinePoint[];
    width?: number;
    height?: number;
    action?: string;
};

const ACTION_COLORS: Record<string, { stroke: string; fill: string }> = {
    Allow: { stroke: '#38A169', fill: 'rgba(56, 161, 105, 0.3)' },
    Deny: { stroke: '#E53E3E', fill: 'rgba(229, 62, 62, 0.3)' },
    Pass: { stroke: '#3182CE', fill: 'rgba(49, 130, 206, 0.3)' },
    Log: { stroke: '#D69E2E', fill: 'rgba(214, 158, 46, 0.3)' },
};

const FlowSparkline: React.FC<Props> = ({
    data,
    width = 120,
    height = 24,
    action = 'Allow',
}) => {
    if (data.length < 2) {
        return (
            <Box w={width} h={height} opacity={0.3}>
                <svg width={width} height={height}>
                    <line
                        x1={0}
                        y1={height / 2}
                        x2={width}
                        y2={height / 2}
                        stroke='#4A5568'
                        strokeWidth={1}
                        strokeDasharray='2,2'
                    />
                </svg>
            </Box>
        );
    }

    const colors = ACTION_COLORS[action] || ACTION_COLORS.Allow;
    const maxVal = Math.max(...data.map((d) => d.value), 1);
    const padding = 2;
    const chartWidth = width - padding * 2;
    const chartHeight = height - padding * 2;

    const points = data.map((d, i) => ({
        x: padding + (i / (data.length - 1)) * chartWidth,
        y:
            padding +
            chartHeight -
            (d.value / maxVal) * chartHeight,
    }));

    const linePath = points.map((p, i) => (i === 0 ? `M${p.x},${p.y}` : `L${p.x},${p.y}`)).join(' ');

    const areaPath =
        linePath +
        ` L${points[points.length - 1].x},${padding + chartHeight} L${points[0].x},${padding + chartHeight} Z`;

    return (
        <Box
            w={width}
            h={height}
            cursor='pointer'
            _hover={{ opacity: 0.9 }}
        >
            <svg width={width} height={height}>
                <path d={areaPath} fill={colors.fill} />
                <path
                    d={linePath}
                    fill='none'
                    stroke={colors.stroke}
                    strokeWidth={1.5}
                />
                {/* Dot on the latest value */}
                <circle
                    cx={points[points.length - 1].x}
                    cy={points[points.length - 1].y}
                    r={2}
                    fill={colors.stroke}
                />
            </svg>
        </Box>
    );
};

export default FlowSparkline;

// Utility: build sparkline data from a set of time-bucketed flows for a given flow key
export type FlowKey = string;

export const flowKeyOf = (flow: FlowLog): FlowKey =>
    `${flow.source_name}|${flow.source_namespace}|${flow.dest_name}|${flow.dest_namespace}|${flow.dest_port}|${flow.protocol}|${flow.action}`;

export const buildSparklineMap = (
    flows: FlowLog[],
): Map<FlowKey, SparklinePoint[]> => {
    const map = new Map<FlowKey, SparklinePoint[]>();

    for (const flow of flows) {
        const key = flowKeyOf(flow);
        if (!map.has(key)) {
            map.set(key, []);
        }
        map.get(key)!.push({
            timestamp: flow.start_time.getTime(),
            value:
                parseInt(flow.bytes_in || '0') +
                parseInt(flow.bytes_out || '0'),
        });
    }

    // Sort each series by timestamp
    for (const [, series] of map) {
        series.sort((a, b) => a.timestamp - b.timestamp);
    }

    return map;
};
