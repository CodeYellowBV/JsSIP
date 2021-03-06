(function(JsSIP) {
var Transport,
  C = {
    // Transport status codes
    STATUS_READY:        0,
    STATUS_DISCONNECTED: 1,
    STATUS_ERROR:        2
  };

Transport = function(ua, server) {

  this.logger = ua.getLogger('jssip.transport');
  this.ua = ua;
  this.ws = null;
  this.server = server;
  this.reconnection_attempts = 0;
  this.closed = false;
  this.connected = false;
  this.reconnectTimer = null;
  this.lastTransportError = {};
};

Transport.prototype = {
  /**
   * Send a message.
   */
  send: function(msg) {
    var message = msg.toString();

    if(this.ws && this.ws.readyState === WebSocket.OPEN) {
      if (this.ua.configuration.trace_sip === true) {
        this.logger.debug('sending WebSocket message:\n\n' + message + '\n');
      }
      this.ws.send(message);
      return true;
    } else {
      this.logger.warn('unable to send message, WebSocket is not open');
      return false;
    }
  },

  /**
  * Disconnect socket.
  */
  disconnect: function() {
    if(this.ws) {
      // Clear reconnectTimer
      window.clearTimeout(this.reconnectTimer);
      // TODO: should make this.reconnectTimer = null here?

      this.closed = true;
      this.logger.debug('closing WebSocket ' + this.server.ws_uri);
      this.ws.close();
    }

    // TODO: Why this??
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.ua.emit('disconnected', this.ua, {
        transport: this,
        code: this.lastTransportError.code,
        reason: this.lastTransportError.reason
      });
    }
  },

  /**
  * Connect socket.
  */
  connect: function() {
    var transport = this;

    if(this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.logger.log('WebSocket ' + this.server.ws_uri + ' is already connected');
      return false;
    }

    if(this.ws) {
      this.ws.close();
    }

    this.logger.log('connecting to WebSocket ' + this.server.ws_uri);
    this.ua.onTransportConnecting(this,
      (this.reconnection_attempts === 0)?1:this.reconnection_attempts);

    try {
      this.ws = new WebSocket(this.server.ws_uri, 'sip');

      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = function() {
        transport.onOpen();
      };

      this.ws.onclose = function(e) {
        transport.onClose(e);
      };

      this.ws.onmessage = function(e) {
        transport.onMessage(e);
      };

      this.ws.onerror = function(e) {
        transport.onError(e);
      };
    } catch(e) {
      this.logger.warn('error connecting to WebSocket ' + this.server.ws_uri + ': ' + e);
      this.lastTransportError.code = null;
      this.lastTransportError.reason = e.message;
      this.ua.onTransportError(this);
    }
  },

  // Transport Event Handlers

  onOpen: function() {
    this.connected = true;

    this.logger.debug('WebSocket ' + this.server.ws_uri + ' connected');
    // Clear reconnectTimer since we are not disconnected
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Reset reconnection_attempts
    this.reconnection_attempts = 0;
    // Disable closed
    this.closed = false;
    // Trigger onTransportConnected callback
    this.ua.onTransportConnected(this);
  },

  onClose: function(e) {
    var connected_before = this.connected;

    this.connected = false;
    this.lastTransportError.code = e.code;
    this.lastTransportError.reason = e.reason;
    this.logger.debug('WebSocket disconnected (code: ' + e.code + (e.reason? '| reason: ' + e.reason : '') +')');

    if(e.wasClean === false) {
      this.logger.warn('WebSocket abrupt disconnection');
    }
    // Transport was connected
    if(connected_before === true) {
      this.ua.onTransportClosed(this);
      // Check whether the user requested to close.
      if(!this.closed) {
        this.reConnect();
      } else {
        this.ua.emit('disconnected', this.ua, {
          transport: this,
          code: this.lastTransportError.code,
          reason: this.lastTransportError.reason
        });
      }
    } else {
      // This is the first connection attempt
      // May be a network error (or may be UA.stop() was called)
      this.ua.onTransportError(this);
    }
  },

  onMessage: function(e) {
    var message, transaction,
      data = e.data;

    // CRLF Keep Alive response from server. Ignore it.
    if(data === '\r\n') {
      if (this.ua.configuration.trace_sip === true) {
        this.logger.debug('received WebSocket message with CRLF Keep Alive response');
      }
      return;
    }

    // WebSocket binary message.
    else if (typeof data !== 'string') {
      try {
        data = String.fromCharCode.apply(null, new Uint8Array(data));
      } catch(evt) {
        this.logger.warn('received WebSocket binary message failed to be converted into string, message discarded');
        return;
      }

      if (this.ua.configuration.trace_sip === true) {
        this.logger.debug('received WebSocket binary message:\n\n' + data + '\n');
      }
    }

    // WebSocket text message.
    else {
      if (this.ua.configuration.trace_sip === true) {
        this.logger.debug('received WebSocket text message:\n\n' + data + '\n');
      }
    }

    message = JsSIP.Parser.parseMessage(data, this.ua);

    if (!message) {
      return;
    }

    if(this.ua.status === JsSIP.UA.C.STATUS_USER_CLOSED && message instanceof JsSIP.IncomingRequest) {
      return;
    }

    // Do some sanity check
    if(! JsSIP.sanityCheck(message, this.ua, this)) {
      return;
    }

    if(message instanceof JsSIP.IncomingRequest) {
      message.transport = this;
      this.ua.receiveRequest(message);
    } else if(message instanceof JsSIP.IncomingResponse) {
      /* Unike stated in 18.1.2, if a response does not match
      * any transaction, it is discarded here and no passed to the core
      * in order to be discarded there.
      */
      switch(message.method) {
        case JsSIP.C.INVITE:
          transaction = this.ua.transactions.ict[message.via_branch];
          if(transaction) {
            transaction.receiveResponse(message);
          }
          break;
        case JsSIP.C.ACK:
          // Just in case ;-)
          break;
        default:
          transaction = this.ua.transactions.nict[message.via_branch];
          if(transaction) {
            transaction.receiveResponse(message);
          }
          break;
      }
    }
  },

  onError: function(e) {
    this.logger.warn('WebSocket connection error: ' + e);
  },

  /**
  * Reconnection attempt logic.
  */
  reConnect: function() {
    var transport = this;

    this.reconnection_attempts += 1;

    if(this.reconnection_attempts > this.ua.configuration.ws_server_max_reconnection) {
      this.logger.warn('maximum reconnection attempts for WebSocket ' + this.server.ws_uri);
      this.ua.onTransportError(this);
    } else {
      this.logger.log('trying to reconnect to WebSocket ' + this.server.ws_uri + ' (reconnection attempt ' + this.reconnection_attempts + ')');

      this.reconnectTimer = window.setTimeout(function() {
        transport.connect();
        transport.reconnectTimer = null;
      }, this.ua.configuration.ws_server_reconnection_timeout * 1000);
    }
  }
};

Transport.C = C;
JsSIP.Transport = Transport;
}(JsSIP));
