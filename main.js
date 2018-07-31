const ROM_VID = 0x0451;
const ROM_PID = 0x6141;
const SPL_VID = 0x0451;
const SPL_PID = 0xd022;
const LINUX_COMPOSITE_DEVICE_VID = 0x1d6b;
const LINUX_COMPOSITE_DEVICE_PID = 0x0104;

// Include modules
const usb = require('usb');
const protocols = require('./lib/protocols');
const EventEmitter = require('events').EventEmitter;
const emitter = new EventEmitter();
const fs = require('fs');
const path = require('path');
const network = require('network');
const cap = require('cap').Cap;
const os = require('os');
const platform = os.platform();
const rndis_init = require('./lib/rndis_init');
const emitterMod = new EventEmitter(); // Emitter for module status
const capture = new cap();
const proxy = require('./lib/proxy');
const identifyRequest = require('./lib/identifyRequest');
const constants = require('./lib/constants');

const proxyConfig = {
  Host: {},
  BB: {},
  ProxyIp: [],
  ArpList: {},
  ActiveInterface: {}
};

const progress = {
  percent: 0, // Percentage for progress
  increment: 5
};

// Set usb debug log
//usb.setDebugLevel(4);   

// TFTP server for USB Mass Storage, binaries must be placed in 'bin/'
exports.usbMassStorage = () => {
  return exports.serveClient([{
    vid: ROM_VID,
    pid: ROM_PID,
    bootpFile: 'u-boot-spl.bin'
  }, {
    vid: SPL_VID,
    pid: SPL_PID,
    bootpFile: 'u-boot.img'
  }]);
};

// Proxy Server for Debian
exports.proxyServer = () => {
  return exports.serveClient([{
    vid: LINUX_COMPOSITE_DEVICE_VID,
    pid: LINUX_COMPOSITE_DEVICE_PID
  }]);
};

// Configuring Server to serve Client
exports.serveClient = (serverConfigs) => {
  let foundDevice;
  progress.increment = (100 / (serverConfigs.length * 10));
  usb.on('attach', (device) => {
    switch (device) {
      case usb.findByIds(ROM_VID, ROM_PID):
        foundDevice = constants.ROM;
        break;
      case usb.findByIds(SPL_VID, SPL_PID):
        foundDevice = (device.deviceDescriptor.bNumConfigurations == 2) ? constants.SPL : constants.UMS;
        break;
      case usb.findByIds(LINUX_COMPOSITE_DEVICE_VID, LINUX_COMPOSITE_DEVICE_PID):
        foundDevice = constants.LINUX_COMPOSITE_DEVICE;
        break;
      default:
        foundDevice = `Device ${device.deviceDescriptor}`;
    }
    emitterMod.emit('connect', foundDevice);

    // Setup BOOTP/ARP/TFTP servers
    serverConfigs.forEach((server) => {
      if (device === usb.findByIds(server.vid, server.pid) && foundDevice != constants.UMS) {
        server.device = device;
        server.foundDevice = foundDevice;
        const timeout = (foundDevice == constants.SPL) ? 500 : 0;
        setTimeout(() => {
          transfer(server);
        }, timeout);
      }
    });
  });

  // USB detach
  usb.on('detach', () => {
    emitterMod.emit('disconnect', foundDevice);
  });

  // Configure Proxy Server for Debian Device
  if (serverConfigs[0].vid === LINUX_COMPOSITE_DEVICE_VID && serverConfigs[0].pid === LINUX_COMPOSITE_DEVICE_PID) emitter.emit('configureProxy');
  return emitterMod; // Event Emitter for progress
};


// Function for device initialization
const transfer = (server) => {
  if (server.foundDevice == constants.ROM) progress.percent = progress.increment;
  updateProgress(`${server.foundDevice} ->`);
  try {
    server.device.open();
    onOpen(server);
  } catch (ex) {
    emitterMod.emit('error', `Can't open device ${ex}`);
  }
};

// Configure Proxy Server
emitter.on('configureProxy', () => {
  // Proxy Server configs
  network.get_active_interface((error, activeInterface) => {
    if (!error) {
      proxyConfig.Host = {
        SourceMac: proxy.getAddressArray(activeInterface.mac_address),
        SourceIp: proxy.getAddressArray(activeInterface.ip_address),
        GatewayIp: proxy.getAddressArray(activeInterface.gateway_ip)
      };
      proxyConfig.BB = {
        SourceIp: [192, 168, 6, 2],
        GatewayIp: [192, 168, 6, 1],
      };
      proxyConfig.ActiveInterface = activeInterface;
      proxy.getAvailableIp(activeInterface.ip_address).then((proxyIp) => {
        proxyConfig.ProxyIp = proxy.getAddressArray(proxyIp);
        console.log(`Using Proxy IP Address: ${proxyIp}`);
      });
    }
  });
});


const onOpen = (server) => {
  try {
    let interfaceNumber = 1; // Interface for data transfer

    // Claim CDC interface to disable networking by Host for Device running Debian
    if (server.foundDevice === constants.LINUX_COMPOSITE_DEVICE) {
      [0, 1, 2, 3, 4, 5].forEach((i) => {
        const devInt = server.device.interface(i);
        if (platform != 'win32') {
          if (devInt && devInt.isKernelDriverActive()) {
            devInt.detachKernelDriver();
          }
        }
        devInt.claim();
      });
      interfaceNumber = 3;
    }

    server.deviceInterface = server.device.interface(interfaceNumber); // Select interface 1 for BULK transfers
    if (platform != 'win32') { // Not supported in Windows
      // Detach Kernel Driver
      if (server.deviceInterface && server.deviceInterface.isKernelDriverActive()) {
        server.deviceInterface.detachKernelDriver();
      }
    }
    server.deviceInterface.claim();
  } catch (err) {
    emitterMod.emit('error', `Can't claim interface ${err}`);
    return;
  }
  updateProgress('Interface claimed');

  // Code to initialize RNDIS device on Windows and OSX
  if (platform != 'linux' && server.foundDevice == constants.ROM) {
    const intf0 = server.device.interface(0); // Select interface 0 for CONTROL transfer
    intf0.claim();
    const CONTROL_BUFFER_SIZE = 1025;
    const RNDIS_INIT_SIZE = 24;
    const RNDIS_SET_SIZE = 28;
    const rndis_buf = Buffer.alloc(CONTROL_BUFFER_SIZE);
    const init_msg = rndis_init.make_rndis_init();
    init_msg.copy(rndis_buf, 0, 0, RNDIS_INIT_SIZE);

    // Windows Control Transfer
    // https://msdn.microsoft.com/en-us/library/aa447434.aspx
    // http://www.beyondlogic.org/usbnutshell/usb6.shtml
    const bmRequestType_send = 0x21; // USB_TYPE=CLASS | USB_RECIPIENT=INTERFACE
    const bmRequestType_receive = 0xA1; // USB_DATA=DeviceToHost | USB_TYPE=CLASS | USB_RECIPIENT=INTERFACE

    // Sending rndis_init_msg (SEND_ENCAPSULATED_COMMAND)
    server.device.controlTransfer(bmRequestType_send, 0, 0, 0, rndis_buf, () => {
      // This error doesn't affect the functionality, so ignoring
      //if(error) emitterMod.emit('error', "Control transfer error on SEND_ENCAPSULATED " +error);
    });

    // Receive rndis_init_cmplt (GET_ENCAPSULATED_RESPONSE)
    server.device.controlTransfer(bmRequestType_receive, 0x01, 0, 0, CONTROL_BUFFER_SIZE, (error) => {
      if (error) emitterMod.emit('error', `Control transfer error on GET_ENCAPSULATED ${error}`);
    });


    const set_msg = rndis_init.make_rndis_set();
    set_msg.copy(rndis_buf, 0, 0, RNDIS_SET_SIZE + 4);

    // Send rndis_set_msg (SEND_ENCAPSULATED_COMMAND)
    server.device.controlTransfer(bmRequestType_send, 0, 0, 0, rndis_buf, () => {
      // This error doesn't affect the functionality, so ignoring
      //if(error) emitterMod.emit('error', "Control transfer error on SEND_ENCAPSULATED " +error);
    });

    // Receive rndis_init_cmplt (GET_ENCAPSULATED_RESPONSE)
    server.device.controlTransfer(bmRequestType_receive, 0x01, 0, 0, CONTROL_BUFFER_SIZE, (error) => {
      if (error) emitterMod.emit('error', `Control transfer error on GET_ENCAPSULATED ${error}`);
    });
  }

  if (server.foundDevice === constants.LINUX_COMPOSITE_DEVICE) {
    server.deviceInterface.setAltSetting(1, (error) => {
      if (error) console.log(error);
      else {
        try {
          // Set endpoints for usb transfer
          server.inEndpoint = server.deviceInterface.endpoint(server.deviceInterface.endpoints[0].address);
          server.outEndpoint = server.deviceInterface.endpoint(server.deviceInterface.endpoints[1].address);

          // Set endpoint transfer type
          server.inEndpoint.transferType = usb.LIBUSB_TRANSFER_TYPE_BULK;
          server.outEndpoint.transferType = usb.LIBUSB_TRANSFER_TYPE_BULK;
        } catch (err) {
          emitterMod.emit('error', `Interface disappeared: ${err}`);
          return;
        }

        // Start polling the In Endpoint for transfers
        server.inEndpoint.startPoll(1, constants.MAXBUF);

        const device = cap.findDevice(proxyConfig.ActiveInterface.ip_address);
        const filter = '';
        const bufSize = 10 * 1024 * 1024;
        let buffer = Buffer.alloc(65535);
        capture.open(device, filter, bufSize, buffer);

        capture.on('packet', () => {
          proxy.processIn(server, capture, buffer, proxyConfig, emitter);
        });
        emitter.emit('inTransfer', server);

      }
    });
  }
  else {
    try {
      // Set endpoints for usb transfer
      server.inEndpoint = server.deviceInterface.endpoint(server.deviceInterface.endpoints[0].address);
      server.outEndpoint = server.deviceInterface.endpoint(server.deviceInterface.endpoints[1].address);

      // Set endpoint transfer type
      server.inEndpoint.transferType = usb.LIBUSB_TRANSFER_TYPE_BULK;
      server.outEndpoint.transferType = usb.LIBUSB_TRANSFER_TYPE_BULK;
    } catch (err) {
      emitterMod.emit('error', `Interface disappeared: ${err}`);
      return;
    }

    // Start polling the In Endpoint for transfers
    server.inEndpoint.startPoll(1, constants.MAXBUF);
    emitter.emit('inTransfer', server);
  }
};

// Event for inEnd transfer
emitter.on('inTransfer', (server) => {
  server.inEndpoint.on('data', (data) => {

    if (server.foundDevice === constants.LINUX_COMPOSITE_DEVICE) {
      proxy.processOut(server, capture, data, proxyConfig);
    }
    else {
      const request = identifyRequest(server, data);
      switch (request) {
        case 'notIdentified':
          emitterMod.emit('error', `${request} packet type`);
          break;
        case 'TFTP':
          updateProgress('TFTP request recieved');
          emitter.emit('processTFTP', server, data);
          break;
        case 'BOOTP':
          updateProgress('BOOTP request recieved');
          emitter.emit('outTransfer', server, processBOOTP(server, data), request);
          break;
        case 'ARP':
          emitter.emit('outTransfer', server, processARP(server, data), request);
          break;
        case 'TFTP_Data':
          if (server.tftp.i <= server.tftp.blocks) { // Transfer until all blocks of file are transferred
            emitter.emit('outTransfer', server, processTFTP_Data(server), request);
          } else {
            updateProgress(`${server.foundDevice} TFTP transfer complete`);
            server.inEndpoint.stopPoll();
          }
          break;
        case 'NC':
          emitter.emit('nc', server, data);
          break;
        default:
          console.log(request);
      }
    }
  });
  server.inEndpoint.on('error', (error) => {
    console.log(error);
  });
});


// Event for outEnd Transfer
emitter.on('outTransfer', (server, data, request) => {
  server.outEndpoint.transfer(data, (error) => {
    if (!error) {
      if (request == 'BOOTP') updateProgress(`${request} reply done`);
    }
  });
});

// Function to process BOOTP request
const processBOOTP = (server, data) => {
  const ether_buf = Buffer.alloc(constants.MAXBUF - constants.RNDIS_SIZE);
  const udp_buf = Buffer.alloc(constants.UDP_SIZE);
  const bootp_buf = Buffer.alloc(constants.BOOTP_SIZE);
  data.copy(udp_buf, 0, constants.RNDIS_SIZE + constants.ETHER_SIZE + constants.IPV4_SIZE, constants.MAXBUF);
  data.copy(bootp_buf, 0, constants.RNDIS_SIZE + constants.ETHER_SIZE + constants.IPV4_SIZE + constants.UDP_SIZE, constants.MAXBUF);
  data.copy(ether_buf, 0, constants.RNDIS_SIZE, constants.MAXBUF);
  server.ether = protocols.decode_ether(ether_buf); // Gets decoded ether packet data
  const udpUboot = protocols.parse_udp(udp_buf); // parsed udp header
  const bootp = protocols.parse_bootp(bootp_buf); // parsed bootp header
  const rndis = protocols.make_rndis(constants.FULL_SIZE - constants.RNDIS_SIZE);
  const eth2 = protocols.make_ether2(server.ether.h_source, server.ether.h_dest, constants.ETH_TYPE_IPV4);
  const ip = protocols.make_ipv4(constants.SERVER_IP, constants.BB_IP, constants.IP_UDP, 0, constants.IPV4_SIZE + constants.UDP_SIZE + constants.BOOTP_SIZE, 0);
  const udp = protocols.make_udp(constants.BOOTP_SIZE, udpUboot.udpDest, udpUboot.udpSrc);
  const bootreply = protocols.make_bootp(constants.SERVER_NAME, server.bootpFile, bootp.xid, server.ether.h_source, constants.BB_IP, constants.SERVER_IP);
  return Buffer.concat([rndis, eth2, ip, udp, bootreply], constants.FULL_SIZE);
};

// Function to process ARP request
const processARP = (server, data) => {
  const arp_buf = Buffer.alloc(constants.ARP_SIZE);
  data.copy(arp_buf, 0, constants.RNDIS_SIZE + constants.ETHER_SIZE, constants.RNDIS_SIZE + constants.ETHER_SIZE + constants.ARP_SIZE);
  server.receivedARP = protocols.parse_arp(arp_buf); // Parsed received ARP request
  const arpResponse = protocols.make_arp(2, server.ether.h_dest, server.receivedARP.ip_dest, server.receivedARP.hw_source, server.receivedARP.ip_source);
  const rndis = protocols.make_rndis(constants.ETHER_SIZE + constants.ARP_SIZE);
  const eth2 = protocols.make_ether2(server.ether.h_source, server.ether.h_dest, constants.ETH_TYPE_ARP);
  return Buffer.concat([rndis, eth2, arpResponse], constants.RNDIS_SIZE + constants.ETHER_SIZE + constants.ARP_SIZE);
};

// Event to process TFTP request
emitter.on('processTFTP', (server, data) => {
  const udpTFTP_buf = Buffer.alloc(constants.UDP_SIZE);
  data.copy(udpTFTP_buf, 0, constants.RNDIS_SIZE + constants.ETHER_SIZE + constants.IPV4_SIZE, constants.RNDIS_SIZE + constants.ETHER_SIZE + constants.IPV4_SIZE + constants.UDP_SIZE);
  server.tftp = {}; // Object containing TFTP parameters
  server.tftp.i = 1; // Keeps count of File Blocks transferred
  server.tftp.receivedUdp = protocols.parse_udp(udpTFTP_buf); // Received UDP packet for SPL tftp
  server.tftp.eth2 = protocols.make_ether2(server.ether.h_source, server.ether.h_dest, constants.ETH_TYPE_IPV4); // Making ether header here, as it remains same for all tftp block transfers
  const fileName = extractName(data);
  server.filePath = path.join('bin', fileName);
  updateProgress(`${fileName} transfer starts`);
  fs.readFile(server.filePath, (error, file_data) => {
    if (!error) {
      server.tftp.blocks = Math.ceil((file_data.length + 1) / 512); // Total number of blocks of file
      server.tftp.start = 0;
      server.tftp.fileData = file_data;
      emitter.emit('outTransfer', server, processTFTP_Data(server), 'TFTP');
    } else {
      emitter.emit('outTransfer', server, processTFTP_Error(server), 'TFTP');
      emitterMod.emit('error', `Error reading ${server.filePath}: ${error}`);
    }
  });
});

// Event for netconsole in
emitter.on('nc', (server, data) => {
  const nc_buf = Buffer.alloc(constants.MAXBUF);
  data.copy(nc_buf, 0, constants.RNDIS_SIZE + constants.ETHER_SIZE + constants.IPV4_SIZE + constants.UDP_SIZE, constants.MAXBUF);
  process.stdout.write(nc_buf.toString());
  if (!server.isNcActive) {
    server.isNcActive = true;
    emitterMod.emit('ncStarted', server);
  }
});

// Event for sending netconsole commands
emitterMod.on('ncin', (server, command) => {
  const data = Buffer.from(command);
  const blockSize = data.length;
  const ncStdinData = Buffer.alloc(blockSize);
  data.copy(ncStdinData, 0, 0, blockSize);
  const rndis = protocols.make_rndis(constants.ETHER_SIZE + constants.IPV4_SIZE + constants.UDP_SIZE + blockSize);
  const eth2 = protocols.make_ether2(server.ether.h_source, server.ether.h_dest, constants.ETH_TYPE_IPV4);
  const ip = protocols.make_ipv4(server.receivedARP.ip_dest, server.receivedARP.ip_source, constants.IP_UDP, 0, constants.IPV4_SIZE + constants.UDP_SIZE + blockSize, 0);
  const udp = protocols.make_udp(blockSize, constants.NETCONSOLE_UDP_PORT, constants.NETCONSOLE_UDP_PORT);
  const packet = Buffer.concat([rndis, eth2, ip, udp, data]);
  emitter.emit('outTransfer', server, packet, 'NC');
});

// Function to process File data for TFTP
const processTFTP_Data = (server) => {
  let blockSize = server.tftp.fileData.length - server.tftp.start;
  if (blockSize > 512) blockSize = 512;
  const blockData = Buffer.alloc(blockSize);
  server.tftp.fileData.copy(blockData, 0, server.tftp.start, server.tftp.start + blockSize); // Copying data to block
  server.tftp.start += blockSize; // Keep counts of bytes transferred upto
  const rndis = protocols.make_rndis(constants.ETHER_SIZE + constants.IPV4_SIZE + constants.UDP_SIZE + constants.TFTP_SIZE + blockSize);
  const ip = protocols.make_ipv4(server.receivedARP.ip_dest, server.receivedARP.ip_source, constants.IP_UDP, 0, constants.IPV4_SIZE + constants.UDP_SIZE + constants.TFTP_SIZE + blockSize, 0);
  const udp = protocols.make_udp(constants.TFTP_SIZE + blockSize, server.tftp.receivedUdp.udpDest, server.tftp.receivedUdp.udpSrc);
  const tftp = protocols.make_tftp(3, server.tftp.i);
  server.tftp.i++;
  return Buffer.concat([rndis, server.tftp.eth2, ip, udp, tftp, blockData], constants.RNDIS_SIZE + constants.ETHER_SIZE + constants.IPV4_SIZE + constants.UDP_SIZE + constants.TFTP_SIZE + blockSize);
};

// Function to handle TFTP error
const processTFTP_Error = (server) => {
  const error_msg = 'File not found';
  const rndis = protocols.make_rndis(constants.ETHER_SIZE + constants.IPV4_SIZE + constants.UDP_SIZE + constants.TFTP_SIZE + error_msg.length + 1);
  const ip = protocols.make_ipv4(server.receivedARP.ip_dest, server.receivedARP.ip_source, constants.IP_UDP, 0, constants.IPV4_SIZE + constants.UDP_SIZE + constants.TFTP_SIZE + error_msg.length + 1, 0);
  const udp = protocols.make_udp(constants.TFTP_SIZE + error_msg.length + 1, server.tftp.receivedUdp.udpDest, server.tftp.receivedUdp.udpSrc);
  const tftp = protocols.make_tftp(5, 1, error_msg);
  return Buffer.concat([rndis, server.tftp.eth2, ip, udp, tftp], constants.RNDIS_SIZE + constants.ETHER_SIZE + constants.IPV4_SIZE + constants.UDP_SIZE + constants.TFTP_SIZE + error_msg.length + 1);
};

// Function for progress update
const updateProgress = (description) => {
  emitterMod.emit('progress', {
    description: description,
    complete: +progress.percent.toFixed(2)
  });
  if (progress.percent <= 100) {
    progress.percent += progress.increment;
  }
};

// Function to extract FileName from TFTP packet
const extractName = (data) => {
  const fv = constants.RNDIS_SIZE + constants.ETHER_SIZE + constants.IPV4_SIZE + constants.UDP_SIZE + 2;
  let nameCount = 0;
  let name = '';
  while (data[fv + nameCount] != 0) {
    name += String.fromCharCode(data[fv + nameCount]);
    nameCount++;
  }
  return name;
};
