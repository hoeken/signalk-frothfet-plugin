var W3CWebSocket = require('websocket').w3cwebsocket;

module.exports = function (app) {
    var plugin = {};
  
    plugin.id = 'signalk-yarrboard-plugin';
    plugin.name = 'Yarrboard';
    plugin.description = 'Plugin for interfacing with Yarrboard';
    
    plugin.connections = [];
  
    plugin.start = function (options, restartPlugin) {
        // Here we put our plugin logic
        app.debug('Plugin started');

        const hosts = options.hosts.split(",");
        app.debug(hosts);

        for (hostname of hosts)
        {
            let yb = plugin.createYarrboard(hostname);
            yb.createWebsocket();

            plugin.connections.push(yb);
        }
    };
  
    plugin.stop = function () {
      // Here we put logic we need when the plugin stops
      app.debug('Plugin stopped');
    };
  
    plugin.schema = {
        type: "object",
        title: "Yarrboard",
        description: "",
        properties: {
            hosts: {
                type: 'string',
                title: 'Yarrboard hostnames, comma separated',
                default: 'yarrboard.local'
            }
        }
    };

    plugin.createYarrboard = function(hostname, username="admin", password="admin", require_login = false)
    {
        var yb = {};

        yb.hostname = hostname;
        yb.username = username;
        yb.password = password;
        yb.require_login = require_login;
    
        yb.createWebsocket = function ()
        {
            var client = new W3CWebSocket(`ws://${this.hostname}/ws`);
            client.onopen = this.onopen.bind(this);
            client.onerror = this.onerror.bind(this);
            client.onclose = this.onclose.bind(this);
            client.onmessage = this.onmessage.bind(this);

            this.client = client;
        }
        
        yb.onerror = function ()
        {
            app.debug(`[${this.hostname}] Connection error`);
        };
        
        yb.onopen = function ()
        {
            console.log(`[${this.hostname}] Connected`);
        
            //we are connected, reload
            this.socket_retries = 0;
            this.retry_time = 0;
            this.last_heartbeat = Date.now();
        
            //our connection watcher
            setTimeout(this.sendHeartbeat.bind(this), 1000);
        
            if (this.require_login)
                this.doLogin("admin", "admin");
        };
        
        yb.onclose = function () {
            console.log(`[${this.hostname}] Connection closed`);
        };
        
        yb.onmessage = function (message)
        {
            if (typeof message.data === 'string') {
                let data = JSON.parse(message.data);
                if (data.msg == "update")
                    true;
                    //this.handleUpdate(data);
                else if (data.pong)
                    this.last_heartbeat = Date.now();
                else
                    app.debug(data);
            }
        }
        
        yb.sendHeartbeat = function ()
        {
            //did we not get a heartbeat?
            if (Date.now() - this.last_heartbeat > 1000 * 2)
            {
                app.debug(`[${this.hostname}] Missed heartbeat: ` + (Date.now() - this.last_heartbeat))
                this.client.close();
                this.retryConnection();
            }
        
            //only send it if we're already open.
            if (this.client.readyState == W3CWebSocket.OPEN)
            {
                this.json({"cmd": "ping"});
                setTimeout(this.sendHeartbeat.bind(this), 1000);
            }
            else if (this.client.readyState == W3CWebSocket.CLOSING)
            {
                app.debug(`[${this.hostname}] closing`);
                this.retryConnection();
            }
            else if (this.client.readyState == W3CWebSocket.CLOSED)
            {
                app.debug(`[${this.hostname}] closed`);
                this.retryConnection();
            }
        }
        
        yb.retryConnection = function ()
        {
            //bail if its good to go
            if (this.client.readyState == W3CWebSocket.OPEN)
                return;
        
            //keep watching if we are connecting
            if (this.client.readyState == W3CWebSocket.CONNECTING)
            {
                app.debug(`[${this.hostname}] Waiting for connection`);
                
                this.retry_time++;
        
                //tee it up.
                setTimeout(this.retryConnection.bind(this), 1000);
        
                return;
            }
        
            //keep track of stuff.
            this.retry_time = 0;
            this.socket_retries++;
            app.debug(`[${this.hostname}] Reconnecting... ${this.socket_retries}`);
        
            //reconnect!
            this.createWebsocket();
        
            //set some bounds
            let my_timeout = 500;
            my_timeout = Math.max(my_timeout, socket_retries * 1000);
            my_timeout = Math.min(my_timeout, 60000);
        
            //tee it up.
            setTimeout(this.retryConnection.bind(this), my_timeout);
        }
        
        yb.doLogin = function (username, password)
        {
            this.json({
                "cmd": "login",
                "user": username,
                "pass": password
            });
        }
        
        yb.json = function (message)
        {
            if (this.client.readyState == W3CWebSocket.OPEN) {
                try {
                    //console.log(message.cmd);
                    this.client.send(JSON.stringify(message));
                } catch (error) {
                    app.debug("Send: " + error);
                }
            }
        }
        
        yb.handleUpdate = function (data)
        {
        }
    
        return yb;
    }

    return plugin;
};