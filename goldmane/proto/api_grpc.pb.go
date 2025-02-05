// Code generated by protoc-gen-go-grpc. DO NOT EDIT.
// versions:
// - protoc-gen-go-grpc v1.5.1
// - protoc             v3.5.0
// source: api.proto

package proto

import (
	context "context"

	grpc "google.golang.org/grpc"
	codes "google.golang.org/grpc/codes"
	status "google.golang.org/grpc/status"
)

// This is a compile-time assertion to ensure that this generated file
// is compatible with the grpc package it is being compiled against.
// Requires gRPC-Go v1.64.0 or later.
const _ = grpc.SupportPackageIsVersion9

const (
	FlowService_List_FullMethodName        = "/goldmane.FlowService/List"
	FlowService_Stream_FullMethodName      = "/goldmane.FlowService/Stream"
	FlowService_FilterHints_FullMethodName = "/goldmane.FlowService/FilterHints"
)

// FlowServiceClient is the client API for FlowService service.
//
// For semantics around ctx use and closing/ending streaming RPCs, please refer to https://pkg.go.dev/google.golang.org/grpc/?tab=doc#ClientConn.NewStream.
//
// FlowService provides APIs for querying aggregated Flow data.
//
// The returned Flows will be aggregated across cluster nodes, as well as the specified aggregation
// time interval.
type FlowServiceClient interface {
	// List is an API call to query for one or more Flows.
	List(ctx context.Context, in *FlowListRequest, opts ...grpc.CallOption) (grpc.ServerStreamingClient[FlowResult], error)
	// Stream is an API call to return a long running stream of new Flows as they are generated.
	Stream(ctx context.Context, in *FlowStreamRequest, opts ...grpc.CallOption) (grpc.ServerStreamingClient[FlowResult], error)
	// FilterHints can be used to discover available filter criteria, such as
	// Namespaces and source / destination names. It allows progressive filtering of criteria based on
	// other filters. i.e., return the flow destinations given a source namespace.
	// Note that this API provides hints to the UI based on past flows and other values may be valid.
	FilterHints(ctx context.Context, in *FilterHintsRequest, opts ...grpc.CallOption) (grpc.ServerStreamingClient[FilterHint], error)
}

type flowServiceClient struct {
	cc grpc.ClientConnInterface
}

func NewFlowServiceClient(cc grpc.ClientConnInterface) FlowServiceClient {
	return &flowServiceClient{cc}
}

func (c *flowServiceClient) List(ctx context.Context, in *FlowListRequest, opts ...grpc.CallOption) (grpc.ServerStreamingClient[FlowResult], error) {
	cOpts := append([]grpc.CallOption{grpc.StaticMethod()}, opts...)
	stream, err := c.cc.NewStream(ctx, &FlowService_ServiceDesc.Streams[0], FlowService_List_FullMethodName, cOpts...)
	if err != nil {
		return nil, err
	}
	x := &grpc.GenericClientStream[FlowListRequest, FlowResult]{ClientStream: stream}
	if err := x.ClientStream.SendMsg(in); err != nil {
		return nil, err
	}
	if err := x.ClientStream.CloseSend(); err != nil {
		return nil, err
	}
	return x, nil
}

// This type alias is provided for backwards compatibility with existing code that references the prior non-generic stream type by name.
type FlowService_ListClient = grpc.ServerStreamingClient[FlowResult]

func (c *flowServiceClient) Stream(ctx context.Context, in *FlowStreamRequest, opts ...grpc.CallOption) (grpc.ServerStreamingClient[FlowResult], error) {
	cOpts := append([]grpc.CallOption{grpc.StaticMethod()}, opts...)
	stream, err := c.cc.NewStream(ctx, &FlowService_ServiceDesc.Streams[1], FlowService_Stream_FullMethodName, cOpts...)
	if err != nil {
		return nil, err
	}
	x := &grpc.GenericClientStream[FlowStreamRequest, FlowResult]{ClientStream: stream}
	if err := x.ClientStream.SendMsg(in); err != nil {
		return nil, err
	}
	if err := x.ClientStream.CloseSend(); err != nil {
		return nil, err
	}
	return x, nil
}

// This type alias is provided for backwards compatibility with existing code that references the prior non-generic stream type by name.
type FlowService_StreamClient = grpc.ServerStreamingClient[FlowResult]

func (c *flowServiceClient) FilterHints(ctx context.Context, in *FilterHintsRequest, opts ...grpc.CallOption) (grpc.ServerStreamingClient[FilterHint], error) {
	cOpts := append([]grpc.CallOption{grpc.StaticMethod()}, opts...)
	stream, err := c.cc.NewStream(ctx, &FlowService_ServiceDesc.Streams[2], FlowService_FilterHints_FullMethodName, cOpts...)
	if err != nil {
		return nil, err
	}
	x := &grpc.GenericClientStream[FilterHintsRequest, FilterHint]{ClientStream: stream}
	if err := x.ClientStream.SendMsg(in); err != nil {
		return nil, err
	}
	if err := x.ClientStream.CloseSend(); err != nil {
		return nil, err
	}
	return x, nil
}

// This type alias is provided for backwards compatibility with existing code that references the prior non-generic stream type by name.
type FlowService_FilterHintsClient = grpc.ServerStreamingClient[FilterHint]

// FlowServiceServer is the server API for FlowService service.
// All implementations must embed UnimplementedFlowServiceServer
// for forward compatibility.
//
// FlowService provides APIs for querying aggregated Flow data.
//
// The returned Flows will be aggregated across cluster nodes, as well as the specified aggregation
// time interval.
type FlowServiceServer interface {
	// List is an API call to query for one or more Flows.
	List(*FlowListRequest, grpc.ServerStreamingServer[FlowResult]) error
	// Stream is an API call to return a long running stream of new Flows as they are generated.
	Stream(*FlowStreamRequest, grpc.ServerStreamingServer[FlowResult]) error
	// FilterHints can be used to discover available filter criteria, such as
	// Namespaces and source / destination names. It allows progressive filtering of criteria based on
	// other filters. i.e., return the flow destinations given a source namespace.
	// Note that this API provides hints to the UI based on past flows and other values may be valid.
	FilterHints(*FilterHintsRequest, grpc.ServerStreamingServer[FilterHint]) error
	mustEmbedUnimplementedFlowServiceServer()
}

// UnimplementedFlowServiceServer must be embedded to have
// forward compatible implementations.
//
// NOTE: this should be embedded by value instead of pointer to avoid a nil
// pointer dereference when methods are called.
type UnimplementedFlowServiceServer struct{}

func (UnimplementedFlowServiceServer) List(*FlowListRequest, grpc.ServerStreamingServer[FlowResult]) error {
	return status.Errorf(codes.Unimplemented, "method List not implemented")
}
func (UnimplementedFlowServiceServer) Stream(*FlowStreamRequest, grpc.ServerStreamingServer[FlowResult]) error {
	return status.Errorf(codes.Unimplemented, "method Stream not implemented")
}
func (UnimplementedFlowServiceServer) FilterHints(*FilterHintsRequest, grpc.ServerStreamingServer[FilterHint]) error {
	return status.Errorf(codes.Unimplemented, "method FilterHints not implemented")
}
func (UnimplementedFlowServiceServer) mustEmbedUnimplementedFlowServiceServer() {}
func (UnimplementedFlowServiceServer) testEmbeddedByValue()                     {}

// UnsafeFlowServiceServer may be embedded to opt out of forward compatibility for this service.
// Use of this interface is not recommended, as added methods to FlowServiceServer will
// result in compilation errors.
type UnsafeFlowServiceServer interface {
	mustEmbedUnimplementedFlowServiceServer()
}

func RegisterFlowServiceServer(s grpc.ServiceRegistrar, srv FlowServiceServer) {
	// If the following call pancis, it indicates UnimplementedFlowServiceServer was
	// embedded by pointer and is nil.  This will cause panics if an
	// unimplemented method is ever invoked, so we test this at initialization
	// time to prevent it from happening at runtime later due to I/O.
	if t, ok := srv.(interface{ testEmbeddedByValue() }); ok {
		t.testEmbeddedByValue()
	}
	s.RegisterService(&FlowService_ServiceDesc, srv)
}

func _FlowService_List_Handler(srv interface{}, stream grpc.ServerStream) error {
	m := new(FlowListRequest)
	if err := stream.RecvMsg(m); err != nil {
		return err
	}
	return srv.(FlowServiceServer).List(m, &grpc.GenericServerStream[FlowListRequest, FlowResult]{ServerStream: stream})
}

// This type alias is provided for backwards compatibility with existing code that references the prior non-generic stream type by name.
type FlowService_ListServer = grpc.ServerStreamingServer[FlowResult]

func _FlowService_Stream_Handler(srv interface{}, stream grpc.ServerStream) error {
	m := new(FlowStreamRequest)
	if err := stream.RecvMsg(m); err != nil {
		return err
	}
	return srv.(FlowServiceServer).Stream(m, &grpc.GenericServerStream[FlowStreamRequest, FlowResult]{ServerStream: stream})
}

// This type alias is provided for backwards compatibility with existing code that references the prior non-generic stream type by name.
type FlowService_StreamServer = grpc.ServerStreamingServer[FlowResult]

func _FlowService_FilterHints_Handler(srv interface{}, stream grpc.ServerStream) error {
	m := new(FilterHintsRequest)
	if err := stream.RecvMsg(m); err != nil {
		return err
	}
	return srv.(FlowServiceServer).FilterHints(m, &grpc.GenericServerStream[FilterHintsRequest, FilterHint]{ServerStream: stream})
}

// This type alias is provided for backwards compatibility with existing code that references the prior non-generic stream type by name.
type FlowService_FilterHintsServer = grpc.ServerStreamingServer[FilterHint]

// FlowService_ServiceDesc is the grpc.ServiceDesc for FlowService service.
// It's only intended for direct use with grpc.RegisterService,
// and not to be introspected or modified (even as a copy)
var FlowService_ServiceDesc = grpc.ServiceDesc{
	ServiceName: "goldmane.FlowService",
	HandlerType: (*FlowServiceServer)(nil),
	Methods:     []grpc.MethodDesc{},
	Streams: []grpc.StreamDesc{
		{
			StreamName:    "List",
			Handler:       _FlowService_List_Handler,
			ServerStreams: true,
		},
		{
			StreamName:    "Stream",
			Handler:       _FlowService_Stream_Handler,
			ServerStreams: true,
		},
		{
			StreamName:    "FilterHints",
			Handler:       _FlowService_FilterHints_Handler,
			ServerStreams: true,
		},
	},
	Metadata: "api.proto",
}

const (
	FlowCollector_Connect_FullMethodName = "/goldmane.FlowCollector/Connect"
)

// FlowCollectorClient is the client API for FlowCollector service.
//
// For semantics around ctx use and closing/ending streaming RPCs, please refer to https://pkg.go.dev/google.golang.org/grpc/?tab=doc#ClientConn.NewStream.
//
// FlowCollector provides APIs capable of receiving streams of Flow data from cluster nodes.
type FlowCollectorClient interface {
	// Connect receives a connection that may stream one or more FlowUpdates. A FlowReceipt is returned
	// to the client by the server after each FlowUpdate.
	//
	// Following a connection or reconnection to the server, clients should duplicates of previously transmitted FlowsUpdates
	// in order to allow the server to rebuild its cache, as well as any new FlowUpdates that have not previously been transmitted.
	// The server is responsible for deduplicating where needed.
	Connect(ctx context.Context, opts ...grpc.CallOption) (grpc.BidiStreamingClient[FlowUpdate, FlowReceipt], error)
}

type flowCollectorClient struct {
	cc grpc.ClientConnInterface
}

func NewFlowCollectorClient(cc grpc.ClientConnInterface) FlowCollectorClient {
	return &flowCollectorClient{cc}
}

func (c *flowCollectorClient) Connect(ctx context.Context, opts ...grpc.CallOption) (grpc.BidiStreamingClient[FlowUpdate, FlowReceipt], error) {
	cOpts := append([]grpc.CallOption{grpc.StaticMethod()}, opts...)
	stream, err := c.cc.NewStream(ctx, &FlowCollector_ServiceDesc.Streams[0], FlowCollector_Connect_FullMethodName, cOpts...)
	if err != nil {
		return nil, err
	}
	x := &grpc.GenericClientStream[FlowUpdate, FlowReceipt]{ClientStream: stream}
	return x, nil
}

// This type alias is provided for backwards compatibility with existing code that references the prior non-generic stream type by name.
type FlowCollector_ConnectClient = grpc.BidiStreamingClient[FlowUpdate, FlowReceipt]

// FlowCollectorServer is the server API for FlowCollector service.
// All implementations must embed UnimplementedFlowCollectorServer
// for forward compatibility.
//
// FlowCollector provides APIs capable of receiving streams of Flow data from cluster nodes.
type FlowCollectorServer interface {
	// Connect receives a connection that may stream one or more FlowUpdates. A FlowReceipt is returned
	// to the client by the server after each FlowUpdate.
	//
	// Following a connection or reconnection to the server, clients should duplicates of previously transmitted FlowsUpdates
	// in order to allow the server to rebuild its cache, as well as any new FlowUpdates that have not previously been transmitted.
	// The server is responsible for deduplicating where needed.
	Connect(grpc.BidiStreamingServer[FlowUpdate, FlowReceipt]) error
	mustEmbedUnimplementedFlowCollectorServer()
}

// UnimplementedFlowCollectorServer must be embedded to have
// forward compatible implementations.
//
// NOTE: this should be embedded by value instead of pointer to avoid a nil
// pointer dereference when methods are called.
type UnimplementedFlowCollectorServer struct{}

func (UnimplementedFlowCollectorServer) Connect(grpc.BidiStreamingServer[FlowUpdate, FlowReceipt]) error {
	return status.Errorf(codes.Unimplemented, "method Connect not implemented")
}
func (UnimplementedFlowCollectorServer) mustEmbedUnimplementedFlowCollectorServer() {}
func (UnimplementedFlowCollectorServer) testEmbeddedByValue()                       {}

// UnsafeFlowCollectorServer may be embedded to opt out of forward compatibility for this service.
// Use of this interface is not recommended, as added methods to FlowCollectorServer will
// result in compilation errors.
type UnsafeFlowCollectorServer interface {
	mustEmbedUnimplementedFlowCollectorServer()
}

func RegisterFlowCollectorServer(s grpc.ServiceRegistrar, srv FlowCollectorServer) {
	// If the following call pancis, it indicates UnimplementedFlowCollectorServer was
	// embedded by pointer and is nil.  This will cause panics if an
	// unimplemented method is ever invoked, so we test this at initialization
	// time to prevent it from happening at runtime later due to I/O.
	if t, ok := srv.(interface{ testEmbeddedByValue() }); ok {
		t.testEmbeddedByValue()
	}
	s.RegisterService(&FlowCollector_ServiceDesc, srv)
}

func _FlowCollector_Connect_Handler(srv interface{}, stream grpc.ServerStream) error {
	return srv.(FlowCollectorServer).Connect(&grpc.GenericServerStream[FlowUpdate, FlowReceipt]{ServerStream: stream})
}

// This type alias is provided for backwards compatibility with existing code that references the prior non-generic stream type by name.
type FlowCollector_ConnectServer = grpc.BidiStreamingServer[FlowUpdate, FlowReceipt]

// FlowCollector_ServiceDesc is the grpc.ServiceDesc for FlowCollector service.
// It's only intended for direct use with grpc.RegisterService,
// and not to be introspected or modified (even as a copy)
var FlowCollector_ServiceDesc = grpc.ServiceDesc{
	ServiceName: "goldmane.FlowCollector",
	HandlerType: (*FlowCollectorServer)(nil),
	Methods:     []grpc.MethodDesc{},
	Streams: []grpc.StreamDesc{
		{
			StreamName:    "Connect",
			Handler:       _FlowCollector_Connect_Handler,
			ServerStreams: true,
			ClientStreams: true,
		},
	},
	Metadata: "api.proto",
}

const (
	StatisticsService_List_FullMethodName = "/goldmane.StatisticsService/List"
)

// StatisticsServiceClient is the client API for StatisticsService service.
//
// For semantics around ctx use and closing/ending streaming RPCs, please refer to https://pkg.go.dev/google.golang.org/grpc/?tab=doc#ClientConn.NewStream.
//
// StatisticsService provides APIs for retrieving Flow statistics.
type StatisticsServiceClient interface {
	// List returns statistics data for the given request. One StatisticsResult will be returned for
	// each matching PolicyHit and direction over the timeframe, containing time-series data covering the
	// provided time range.
	List(ctx context.Context, in *StatisticsRequest, opts ...grpc.CallOption) (grpc.ServerStreamingClient[StatisticsResult], error)
}

type statisticsServiceClient struct {
	cc grpc.ClientConnInterface
}

func NewStatisticsServiceClient(cc grpc.ClientConnInterface) StatisticsServiceClient {
	return &statisticsServiceClient{cc}
}

func (c *statisticsServiceClient) List(ctx context.Context, in *StatisticsRequest, opts ...grpc.CallOption) (grpc.ServerStreamingClient[StatisticsResult], error) {
	cOpts := append([]grpc.CallOption{grpc.StaticMethod()}, opts...)
	stream, err := c.cc.NewStream(ctx, &StatisticsService_ServiceDesc.Streams[0], StatisticsService_List_FullMethodName, cOpts...)
	if err != nil {
		return nil, err
	}
	x := &grpc.GenericClientStream[StatisticsRequest, StatisticsResult]{ClientStream: stream}
	if err := x.ClientStream.SendMsg(in); err != nil {
		return nil, err
	}
	if err := x.ClientStream.CloseSend(); err != nil {
		return nil, err
	}
	return x, nil
}

// This type alias is provided for backwards compatibility with existing code that references the prior non-generic stream type by name.
type StatisticsService_ListClient = grpc.ServerStreamingClient[StatisticsResult]

// StatisticsServiceServer is the server API for StatisticsService service.
// All implementations must embed UnimplementedStatisticsServiceServer
// for forward compatibility.
//
// StatisticsService provides APIs for retrieving Flow statistics.
type StatisticsServiceServer interface {
	// List returns statistics data for the given request. One StatisticsResult will be returned for
	// each matching PolicyHit and direction over the timeframe, containing time-series data covering the
	// provided time range.
	List(*StatisticsRequest, grpc.ServerStreamingServer[StatisticsResult]) error
	mustEmbedUnimplementedStatisticsServiceServer()
}

// UnimplementedStatisticsServiceServer must be embedded to have
// forward compatible implementations.
//
// NOTE: this should be embedded by value instead of pointer to avoid a nil
// pointer dereference when methods are called.
type UnimplementedStatisticsServiceServer struct{}

func (UnimplementedStatisticsServiceServer) List(*StatisticsRequest, grpc.ServerStreamingServer[StatisticsResult]) error {
	return status.Errorf(codes.Unimplemented, "method List not implemented")
}
func (UnimplementedStatisticsServiceServer) mustEmbedUnimplementedStatisticsServiceServer() {}
func (UnimplementedStatisticsServiceServer) testEmbeddedByValue()                           {}

// UnsafeStatisticsServiceServer may be embedded to opt out of forward compatibility for this service.
// Use of this interface is not recommended, as added methods to StatisticsServiceServer will
// result in compilation errors.
type UnsafeStatisticsServiceServer interface {
	mustEmbedUnimplementedStatisticsServiceServer()
}

func RegisterStatisticsServiceServer(s grpc.ServiceRegistrar, srv StatisticsServiceServer) {
	// If the following call pancis, it indicates UnimplementedStatisticsServiceServer was
	// embedded by pointer and is nil.  This will cause panics if an
	// unimplemented method is ever invoked, so we test this at initialization
	// time to prevent it from happening at runtime later due to I/O.
	if t, ok := srv.(interface{ testEmbeddedByValue() }); ok {
		t.testEmbeddedByValue()
	}
	s.RegisterService(&StatisticsService_ServiceDesc, srv)
}

func _StatisticsService_List_Handler(srv interface{}, stream grpc.ServerStream) error {
	m := new(StatisticsRequest)
	if err := stream.RecvMsg(m); err != nil {
		return err
	}
	return srv.(StatisticsServiceServer).List(m, &grpc.GenericServerStream[StatisticsRequest, StatisticsResult]{ServerStream: stream})
}

// This type alias is provided for backwards compatibility with existing code that references the prior non-generic stream type by name.
type StatisticsService_ListServer = grpc.ServerStreamingServer[StatisticsResult]

// StatisticsService_ServiceDesc is the grpc.ServiceDesc for StatisticsService service.
// It's only intended for direct use with grpc.RegisterService,
// and not to be introspected or modified (even as a copy)
var StatisticsService_ServiceDesc = grpc.ServiceDesc{
	ServiceName: "goldmane.StatisticsService",
	HandlerType: (*StatisticsServiceServer)(nil),
	Methods:     []grpc.MethodDesc{},
	Streams: []grpc.StreamDesc{
		{
			StreamName:    "List",
			Handler:       _StatisticsService_List_Handler,
			ServerStreams: true,
		},
	},
	Metadata: "api.proto",
}
