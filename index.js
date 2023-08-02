var W3CWebSocket = require('websocket').w3cwebsocket;

module.exports = function (app) {
    var plugin = {};
  
    plugin.id = 'signalk-yarrboard-plugin';
    plugin.name = 'Yarrboard';
    plugin.description = 'Plugin for interfacing with Yarrboard';
    
    plugin.connections = [];

    plugin.channelMetas = {
        "id": {"units": "", "description": "ID of each channel."},
        "name": {"units": "", "description": "User defined name of channel."},
        "type": {"units": "", "description": "Channel type.  Currently only 'mosfet'."},
        "enabled": {"units": "", "description": "Whether or not this channel is in use or should be ignored."},
        "hasPWM": {"units": "", "description": "Whether this channel hardware is capable of PWM (duty cycle, dimming, etc)"},
        "hasCurrent": {"units": "", "description": "Whether this channel has current monitoring."},
        "softFuse": {"units": "A", "description": "Software defined fuse, in amps."},
        "isDimmable": {"units": "", "description": "Whether the channel has dimming enabled or not."},
        "state": {"units": "", "description": "Whether the channel is on or not."},
        "duty": {"units": "%", "description": "Duty cycle as a percentage from 0 to 1"},
        "current": {"units": "A", "description": "Current in amps"},
        "aH": {"units": "aH", "description": "Consumed amp hours since board restart"},
        "wH": {"units": "wH", "description": "Consumed watt hours since board restart"},
    }
  
    plugin.start = function (options, restartPlugin) {
        // Here we put our plugin logic
        app.debug('Plugin started');
        //app.debug('Schema: %s', JSON.stringify(options));

        for (board of options.config)
        {
            //app.debug('Board: %s', JSON.stringify(board));

            let yb = plugin.createYarrboard(board.host.trim(), board.username, board.password, board.require_login);
            plugin.connections.push(yb);
        }
    };
  
    plugin.stop = function () {
        // Here we put logic we need when the plugin stops
        app.debug('Plugin stopped');

        //close all our connections
        for (yb of plugin.connections)
            yb.close();
        plugin.connections = [];
    };
  
    plugin.schema = {
        title: "Yarrboard",
        type: "object",
        properties: {
            config: {
                type: 'array',
                title: 'Add board config',
                items: {
                    type: 'object',
                    properties: {
                        host: {
                            type: 'string',
                            title: 'Yarrboard hostname or IP',
                            default: 'yarrboard.local'
                        },
                        require_login: {
                            type: 'boolean',
                            title: 'Login required?',
                            default: false,
                        },
                        username: {
                            type: 'string',
                            title: 'Username',
                            default: 'admin',
                        },
                        password: {
                            type: 'string',
                            title: 'Password',
                            default: 'admin',
                        }    
                    }
                }
            }
        }
    };

    plugin.createYarrboard = function(hostname, username="admin", password="admin", require_login = false)
    {
        var yb = {};
        yb.config = false;
        yb.closed = false;

        yb.metaPaths = [];
        yb.metas = [];
        yb.deltas = [];

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
            app.debug(`[${this.hostname}] Connected`);
        
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
            app.debug(`[${this.hostname}] Connection closed`);
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
                    else if (data.error)
                    {
                        app.debug(`[${this.hostname}] Error: ${data.error}`);
                        app.setPluginError(`[${this.hostname}] ${data.error}`);
                    }
                    else if (data.success)
                    {
                        app.debug(`[${this.hostname}] Success: ${data.success}`);
                        app.setPluginStatus(`[${this.hostname}] ${data.success}`);
                    }
                    else
                        app.debug(data);    
                } catch (error) {
                    app.debug(`[${this.hostname}] Message error: ${error}`);
                    //app.debug(message);
                }
            }
        }

        yb.close = function () {
            this.closed = true;
            this.ws.close();
        }

        yb.getConfig = function () {
            this.json({"cmd": "get_config"});
        }
        
        yb.sendHeartbeat = function ()
        {
            //bail if we're done.
            if (this.closed)
                return;

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
            //bail if we're done.
            if (this.closed)
                return;
        
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
                    //app.debug(message.cmd);
                    this.ws.send(JSON.stringify(message));
                } catch (error) {
                    app.debug(`[${this.hostname}] Send error: ${error}`);
                }
            }
        }

        yb.handleConfig = function (data)
        {
            this.config = data;

            let mainPath = this.getMainBoardPath();

            app.registerPutHandler('vessels.self', `${mainPath}/control/setState`, this.doSetState.bind(this));
            app.registerPutHandler('vessels.self', `${mainPath}/control/setDuty`, this.doSetDuty.bind(this));

            //console.log(JSON.stringify(data));

            this.queueUpdate(`${mainPath}/board/version`, data.version, "", "Firmware version of the board.");
            this.queueUpdate(`${mainPath}/board/name`, data.name, "", "User defined name of the board.");
            this.queueUpdate(`${mainPath}/board/uuid`, data.uuid, "", "Unique ID of the board.");

            for (channel of data.channels)
            {
                if(channel.enabled)
                {
                    let channelPath = `${mainPath}/channel/${channel.id}`;
                    for (const [key, value] of Object.entries(channel))
                    {
                        this.queueDelta(`${channelPath}/${key}`, value);

                        if (plugin.channelMetas.hasOwnProperty(key))
                            this.queueMeta(`${channelPath}/${key}`, plugin.channelMetas[key].units, plugin.channelMetas[key].description);
                    }
                }
            }

            this.sendUpdates();
        }

        yb.handleUpdate = function (data)
        {
            if (!this.config)
                return;

            //console.log(JSON.stringify(data));

            let mainPath = this.getMainBoardPath();

            this.queueUpdate(`${mainPath}/board/bus_voltage`, data.bus_voltage, 'V', "Bus supply voltage");

            for (channel of data.channels)
            {
                if (this.config.channels[channel.id].enabled)
                {
                    let channelPath = `${mainPath}/channel/${channel.id}`;
                    for (const [key, value] of Object.entries(channel))
                    {
                        this.queueDelta(`${channelPath}/${key}`, value);

                        if (plugin.channelMetas.hasOwnProperty(key))
                            this.queueMeta(`${channelPath}/${key}`, plugin.channelMetas[key].units, plugin.channelMetas[key].description);
                    }
                }
            }

            this.sendUpdates();
        }

        yb.getMainBoardPath = function (data)
        {
            return `electrical/yarrboard/${this.config.hostname}`;
        }

        yb.queueUpdate = function (path, value, units, description)
        {
            this.queueDelta(path, value);
            this.queueMeta(path, units, description);
        }

        yb.queueDelta = function (path, value)
        {
            this.deltas.push({ "path": path, "value": value });
        }

        yb.queueMeta = function (path, units, description)
        {
            //only send it once
            //if (this.metaPaths.includes(path))
            //    return;
            //this.metaPaths.push(path);

            //add it to our array
            let meta = {
                "path": path,
                "value": {}
            };

            if (units != "")
                meta.value.units = units;
            if (description != "")
                meta.value.description = description;

            this.metas.push(meta);
        }

        yb.sendDeltas = function ()
        {
            if (!this.deltas.length)
                return;

            //app.debug('Deltas: %s', this.deltas.length);

            app.handleMessage(plugin.id, {
                "updates": [{
                    "values": this.deltas
                }]
            });

            //for (delta of this.deltas)
            //    app.handleMessage(plugin.id, {"updates": [{"values": [delta]}]});

            this.deltas = [];
        }

        yb.sendMetas = function ()
        {
            //metas is broken for now
            return;

            //if (!this.metas.length)
            //    return;

            //app.debug('Metas: %s', JSON.stringify(this.metas));

            app.handleMessage(plugin.id, {
                "updates": [{ 
                    "meta": this.metas
                }]
            });

            //for (meta of this.metas)
            //    app.handleMessage(plugin.id, {"updates": [{"meta": [meta]}]});

            this.metas = [];
        }

        yb.sendUpdates = function ()
        {
            yb.sendDeltas();
            yb.sendMetas();
        }

        yb.doSetState = function(context, path, value, callback)
        {
            let cid = parseInt(value.id);
            let state = Boolean(value.value);

            if (this.config.channels[cid].enabled)
            {
                this.json({
                    "cmd": "set_state",
                    "id": cid,
                    "value": state
                });

                return { state: 'COMPLETED', statusCode: 200 };
            }
            else
                app.setPluginError(`Channel ${cid} not enabled`)

            return { state: 'COMPLETED', statusCode: 400 };
        }

        yb.doSetDuty = function(context, path, value, callback)
        {
            let cid = parseInt(value.id);
            let duty = parseFloat(value.value);

            if (this.config.channels[cid].enabled)
            {
                if (this.config.channels[cid].isDimmable)
                {
                    this.json({
                        "cmd": "set_duty",
                        "id": cid,
                        "value": duty
                    });
                    
                    return { state: 'COMPLETED', statusCode: 200 };
                }
                else
                    app.setPluginError(`Channel ${cid} not dimmable`)
            }
            else
                app.setPluginError(`Channel ${cid} not enabled`)

            return { state: 'COMPLETED', statusCode: 400 };
        }

        yb.createWebsocket();
    
        return yb;
    }

    return plugin;
};