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
            hostname = hostname.trim();
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
        yb.config = false;

        yb.hostname = hostname;
        yb.username = username;
        yb.password = password;
        yb.require_login = require_login;

        yb.boardname = hostname.split(".")[0];
    
        yb.createWebsocket = function ()
        {
            var ws = new W3CWebSocket(`ws://${this.hostname}/ws`);
            ws.onopen = this.onopen.bind(this);
            ws.onerror = this.onerror.bind(this);
            ws.onclose = this.onclose.bind(this);
            ws.onmessage = this.onmessage.bind(this);

            this.ws = ws;
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

            //load our config
            setTimeout(this.getConfig.bind(this), 50);
        
            if (this.require_login)
                this.doLogin("admin", "admin");
        };
        
        yb.onclose = function () {
            console.log(`[${this.hostname}] Connection closed`);
        };
        
        yb.onmessage = function (message)
        {
            if (typeof message.data === 'string') {
                try {
                    let data = JSON.parse(message.data);
                    if (data.msg == "update")
                        this.handleUpdate(data);
                    else if (data.msg == "config")
                        this.handleConfig(data);
                    else if (data.pong)
                        this.last_heartbeat = Date.now();
                    else
                        app.debug(data);    
                } catch (error) {
                    app.debug(`[${this.hostname}] Message error: ${error}`);
                    //app.debug(message);
                }
            }
        }

        yb.getConfig = function () {
            this.json({"cmd": "get_config"});
        }
        
        yb.sendHeartbeat = function ()
        {
            //did we not get a heartbeat?
            if (Date.now() - this.last_heartbeat > 1000 * 2)
            {
                app.debug(`[${this.hostname}] Missed heartbeat`)
                this.ws.close();
                this.retryConnection();
            }
        
            //only send it if we're already open.
            if (this.ws.readyState == W3CWebSocket.OPEN)
            {
                this.json({"cmd": "ping"});
                setTimeout(this.sendHeartbeat.bind(this), 1000);
            }
            else if (this.ws.readyState == W3CWebSocket.CLOSING)
            {
                app.debug(`[${this.hostname}] closing`);
                this.retryConnection();
            }
            else if (this.ws.readyState == W3CWebSocket.CLOSED)
            {
                app.debug(`[${this.hostname}] closed`);
                this.retryConnection();
            }
        }
        
        yb.retryConnection = function ()
        {
            //bail if its good to go
            if (this.ws.readyState == W3CWebSocket.OPEN)
                return;
        
            //keep watching if we are connecting
            if (this.ws.readyState == W3CWebSocket.CONNECTING)
            {
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
            my_timeout = Math.max(my_timeout, this.socket_retries * 1000);
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
            if (this.ws.readyState == W3CWebSocket.OPEN) {
                try {
                    //console.log(message.cmd);
                    this.ws.send(JSON.stringify(message));
                } catch (error) {
                    app.debug(`[${this.hostname}] Send error: ${error}`);
                }
            }
        }

        yb.handleConfig = function (data)
        {
            this.config = data;

            let updates = [];
            let mainPath = this.getMainBoardPath();

            updates.push(this.formatDelta(`${mainPath}/board/version`, data.version));
            updates.push(this.formatDelta(`${mainPath}/board/name`, data.name));
            updates.push(this.formatDelta(`${mainPath}/board/uuid`, data.uuid));

            for (channel of data.channels)
            {
                if(channel.enabled)
                {
                    let channelPath = `${mainPath}/channel/${channel.id}`;
                    for (const [key, value] of Object.entries(channel)) {
                        updates.push(this.formatDelta(`${channelPath}/${key}`, value));
                    }    
                }
            }

            this.sendDeltas(updates);
        }

        yb.handleUpdate = function (data)
        {
            if (!this.config)
                return;

            let updates = [];
            let mainPath = this.getMainBoardPath();

            updates.push(this.formatDelta(`${mainPath}/board/bus_voltage`, data.bus_voltage));

            for (channel of data.channels)
            {
                if (this.config.channels[channel.id].enabled)
                {
                    let channelPath = `${mainPath}/channel/${channel.id}`;
                    for (const [key, value] of Object.entries(channel)) {
                        updates.push(this.formatDelta(`${channelPath}/${key}`, value));
                    }    
                }
            }

            this.sendDeltas(updates);
        }

        yb.getMainBoardPath = function (data)
        {
            return `electrical/yarrboard/${this.config.hostname}`;
        }

        yb.formatDelta = function (path, value)
        {
            return { "path": path, "value": value };
        }

        yb.sendDeltas = function (deltas)
        {
            app.handleMessage(plugin.id, {
                "updates": [
                    {
                        "values": deltas
                    }
                ]
            });
        }
    
        return yb;
    }

    return plugin;
};