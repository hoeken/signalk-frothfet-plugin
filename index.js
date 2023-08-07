const YarrboardClient = require('yarrboard-client');

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
        var yb = new YarrboardClient(hostname, username, password, require_login);

        yb.metaPaths = [];
        yb.metas = [];
        yb.deltas = [];
        
        yb.onmessage = function (data)
        {
            if (data.msg == "update")
                this.handleUpdate(data);
            else if (data.msg == "config")
                this.handleConfig(data);
            else if (data.msg = "status")
            {
                if (data.status == "error")
                    app.setPluginError(`[${this.hostname}] ${data.message}`);
                else if (data.status == "success")
                    app.setPluginStatus(`[${this.hostname}] ${data.message}`);
            }
        }

        yb.handleConfig = function (data)
        {
            this.config = data;

            let mainPath = this.getMainBoardPath();

            app.registerPutHandler('vessels.self', `${mainPath}.control`, this.doSendJSON.bind(this));

            //console.log(JSON.stringify(data));

            this.queueUpdate(`${mainPath}.board.firmware_version`, data.firmware_version, "", "Firmware version of the board.");
            this.queueUpdate(`${mainPath}.board.hardware_version`, data.hardware_version, "", "Hardware version of the board.");
            this.queueUpdate(`${mainPath}.board.name`, data.name, "", "User defined name of the board.");
            this.queueUpdate(`${mainPath}.board.uuid`, data.uuid, "", "Unique ID of the board.");

            for (channel of data.channels)
            {
                if(channel.enabled)
                {
                    let channelPath = `${mainPath}.channel.${channel.id}`;
                    for (const [key, value] of Object.entries(channel))
                    {
                        this.queueDelta(`${channelPath}.${key}`, value);

                        if (plugin.channelMetas.hasOwnProperty(key))
                            this.queueMeta(`${channelPath}.${key}`, plugin.channelMetas[key].units, plugin.channelMetas[key].description);
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

            this.queueUpdate(`${mainPath}.board.bus_voltage`, data.bus_voltage, 'V', "Bus supply voltage");

            for (channel of data.channels)
            {
                if (this.config.channels[channel.id].enabled)
                {
                    let channelPath = `${mainPath}.channel.${channel.id}`;
                    for (const [key, value] of Object.entries(channel))
                    {
                        this.queueDelta(`${channelPath}.${key}`, value);

                        if (plugin.channelMetas.hasOwnProperty(key))
                            this.queueMeta(`${channelPath}.${key}`, plugin.channelMetas[key].units, plugin.channelMetas[key].description);
                    }
                }
            }

            this.sendUpdates();
        }

        yb.getMainBoardPath = function (data)
        {
            return `electrical.yarrboard.${this.config.hostname}`;
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
            if (this.metaPaths.includes(path))
                return;
            this.metaPaths.push(path);

            //add it to our array
            let meta = {
                "path": path,
                "value": {
                    "units": units,
                    "description": description
                }
            };

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

            this.deltas = [];
        }

        yb.sendMetas = function ()
        {
            if (!this.metas.length)
                return;

            let update = {
                "updates": [{ 
                    "meta": this.metas
                }]
            };

            app.handleMessage(plugin.id, update);

            this.metas = [];
        }

        yb.sendUpdates = function ()
        {
            yb.sendDeltas();
            yb.sendMetas();
        }

        yb.doSendJSON = function(context, path, value, callback)
        {
            this.json(value);

            return { state: 'COMPLETED', statusCode: 200 };
        }

        yb.start();
    
        return yb;
    }

    return plugin;
};