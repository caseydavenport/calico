import unittest
import uuid
from test_base import TestBase
from docker_host import DockerHost


class Ipv6MultiHostMainline(TestBase):

    @unittest.skip("Libnetwork doesn't support multi-host yet.")
    def test_ipv6_multi_host(self):
        """
        Run a mainline multi-host test with IPv6.

        Almost identical in function to the vagrant coreOS demo.
        """
        with DockerHost('host1') as host1, DockerHost('host2') as host2:

            net135 = host1.create_network(str(uuid.uuid4()))
            net2 = host1.create_network(str(uuid.uuid4()))
            net4 = host1.create_network(str(uuid.uuid4()))

            # We use this image here because busybox doesn't have ping6.
            workload1 = host1.create_workload("workload1",
                                              image="phusion/baseimage:0.9.16",
                                              network=net135)
            workload2 = host1.create_workload("workload2",
                                              image="phusion/baseimage:0.9.16",
                                              network=net2)
            workload3 = host1.create_workload("workload3",
                                              image="phusion/baseimage:0.9.16",
                                              network=net135)

            workload4 = host2.create_workload("workload4",
                                              image="phusion/baseimage:0.9.16",
                                              network=net4)
            workload5 = host2.create_workload("workload5",
                                              image="phusion/baseimage:0.9.16",
                                              network=net135)

            self.assert_connectivity(pass_list=[workload1,
                                                workload3,
                                                workload5],
                                     fail_list=[workload2, workload4])

            self.assert_connectivity(pass_list=[workload2],
                                     fail_list=[workload1,
                                                workload3,
                                                workload4,
                                                workload5])

            self.assert_connectivity(pass_list=[workload4],
                                     fail_list=[workload1,
                                                workload2,
                                                workload3,
                                                workload5])
