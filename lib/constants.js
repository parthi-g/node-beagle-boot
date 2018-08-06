module.exports = Object.freeze({
  BOOTPS: 67,
  BOOTPC: 68,
  IP_UDP: 17,
  IPV6_HOP_BY_HOP_OPTION: 0,
  IPV6_ICMP: 0x3A,
  IP_TCP: 0x06,
  TFTP_PORT: 69,
  NETCONSOLE_UDP_PORT: 6666,
  MDNS_UDP_PORT: 5353,
  ETH_TYPE_ARP: 0x0806,
  ETH_TYPE_IPV4: 0x0800,
  ETH_TYPE_IPV6: 0x86DD,
  ARP_OPCODE_REQUEST: 1,
  ARP_OPCODE_REPLY: 2,
  SERVER_IP: [0xc0, 0xa8, 0x01, 0x09], // 192.168.1.9
  BB_IP: [0xc0, 0xa8, 0x01, 0x03], // 192.168.1.3
  SERVER_NAME: [66, 69, 65, 71, 76, 69, 66, 79, 79, 84], // ASCII ['B','E','A','G','L','E','B','O','O','T']
  MAXBUF: 500,
  ROM: 'ROM',
  SPL: 'SPL',
  UMS: 'UMS',
  LINUX_COMPOSITE_DEVICE: 'LINUX_COMPOSITE_DEVICE',
  ROM_VID: 0x0451,
  ROM_PID: 0x6141,
  SPL_VID: 0x0451,
  SPL_PID: 0xd022,
  LINUX_COMPOSITE_DEVICE_VID: 0x1d6b,
  LINUX_COMPOSITE_DEVICE_PID: 0x0104,

  // Size of all protocol headers
  RNDIS_SIZE: 44,
  ETHER_SIZE: 14,
  ARP_SIZE: 28,
  IPV4_SIZE: 20,
  IPV6_SIZE: 40,
  UDP_SIZE: 8,
  BOOTP_SIZE: 300,
  TFTP_SIZE: 4,
  FULL_SIZE: 386,
});