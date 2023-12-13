const YarrboardClient = require('yarrboard-client');

module.exports = function (app) {
    var plugin = {};
  
    plugin.id = 'signalk-yarrboard-plugin';
    plugin.name = 'Yarrboard';
    plugin.description = 'Plugin for interfacing with Yarrboard';
    
    plugin.connections = [];

    plugin.pwmMetas = {
        "id": {"units": "", "description": "ID of each channel."},
        "name": {"units": "", "description": "User defined name of channel."},
        "enabled": {"units": "", "description": "Whether or not this channel is in use or should be ignored."},
        "hasPWM": {"units": "", "description": "Whether this channel hardware is capable of PWM (duty cycle, dimming, etc)"},
        "hasCurrent": {"units": "", "description": "Whether this channel has current monitoring."},
        "softFuse": {"units": "A", "description": "Software defined fuse, in amps."},
        "isDimmable": {"units": "", "description": "Whether the channel has dimming enabled or not."},
        "state": {"units": "", "description": "Whether the channel is on or not."},
        "duty": {"units": "%", "description": "Duty cycle as a ratio from 0 to 1"},
        "current": {"units": "A", "description": "Current in amps"},
        "aH": {"units": "aH", "description": "Consumed amp hours since board restart"},
        "wH": {"units": "wH", "description": "Consumed watt hours since board restart"},
    }

    plugin.switchMetas = {
        "id": {"units": "", "description": "ID of each switch."},
        "name": {"units": "", "description": "User defined name of switch."},
        "enabled": {"units": "", "description": "Whether or not this switch is in use or should be ignored."},
        "isOpen": {"units": "", "description": "Whether the switch is open or closed"},
    }

    plugin.adcMetas = {
        "id": {"units": "", "description": "ID of each switch."},
        "name": {"units": "", "description": "User defined name of switch."},
        "enabled": {"units": "", "description": "Whether or not this switch is in use or should be ignored."},
        "reading": {"units": "", "description": "The raw reading from the ADC chip"},
        "voltage": {"units": "V", "description": "Voltage reading at the ADC chip"},
        "percentage": {"units": "%", "description": "Percentage along the ADC chip range"},
    }

    plugin.rgbMetas = {
        "id": {"units": "", "description": "ID of each switch."},
        "name": {"units": "", "description": "User defined name of switch."},
        "enabled": {"units": "", "description": "Whether or not this switch is in use or should be ignored."},
        "red": {"units": "", "description": "Red LED brightness on a scale of 0 to 1"},
        "green": {"units": "", "description": "Green LED brightness on a scale of 0 to 1"},
        "blue": {"units": "", "description": "Blue LED brightness on a scale of 0 to 1"},
    }

    plugin.start = function (options, restartPlugin) {
        // Here we put our plugin logic
        app.debug('Plugin started2');
        app.debug(YarrboardClient.version);
        //app.debug('Schema: %s', JSON.stringify(options));

        for (board of options.config)
        {
            //app.debug('Board: %s', JSON.stringify(board));

            let yb = plugin.createYarrboard(board.host.trim(), board.username, board.password, board.require_login, board.use_ssl);

            yb.onopen = function (event) {
                yb.getConfig();
                yb.startUpdatePoller(board.update_interval);
            }
            
            yb.start();            

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
                        update_interval: {
                            type: 'number',
                            title: 'Update interval (ms)',
                            default: 1000
                        },
                        require_login: {
                            type: 'boolean',
                            title: 'Login required?',
                            default: false,
                        },
                        use_ssl: {
                            type: 'boolean',
                            title: 'Use SSL / HTTPS?',
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

    plugin.createYarrboard = function(hostname, username="admin", password="admin", require_login = false, use_ssl = false)
    {
        var yb = new YarrboardClient(hostname, username, password, require_login, use_ssl);

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

        yb.queueDeltasAndUpdates = function (data) {

            let mainPath = this.getMainBoardPath();

            //pwm channels?
            if (data.pwm)
            {
                for (ch of data.pwm)
                {
                    if(this.config.pwm[ch.id].enabled)
                    {
                        let chPath = `${mainPath}.pwm.${ch.id}`;
                        for (const [key, value] of Object.entries(ch))
                        {
                            this.queueDelta(`${chPath}.${key}`, value);

                            if (plugin.pwmMetas.hasOwnProperty(key))
                                this.queueMeta(`${chPath}.${key}`, plugin.pwmMetas[key].units, plugin.pwmMetas[key].description);
                        }
                    }
                }    
            }

            //switch channels?
            if (data.switches)
            {
                for (ch of data.switches)
                {
                    if(this.config.switches[ch.id].enabled)
                    {
                        let chPath = `${mainPath}.switches.${ch.id}`;
                        for (const [key, value] of Object.entries(ch))
                        {
                            this.queueDelta(`${chPath}.${key}`, value);

                            if (plugin.switchMetas.hasOwnProperty(key))
                                this.queueMeta(`${chPath}.${key}`, plugin.switchMetas[key].units, plugin.switchMetas[key].description);
                        }
                    }
                }    
            }

            //adc channels?
            if (data.adc)
            {
                for (ch of data.adc)
                {
                    if (this.config.adc[ch.id].enabled)
                    {
                        let chPath = `${mainPath}.adc.${ch.id}`;
                        for (const [key, value] of Object.entries(ch))
                        {
                            this.queueDelta(`${chPath}.${key}`, value);

                            if (plugin.adcMetas.hasOwnProperty(key))
                                this.queueMeta(`${chPath}.${key}`, plugin.adcMetas[key].units, plugin.adcMetas[key].description);
                        }
                    }
                }    
            }

            //rgb channels?
            if (data.rgb)
            {
                for (ch of data.rgb)
                {
                    if (this.config.rgb[ch.id].enabled)
                    {
                        let chPath = `${mainPath}.rgb.${ch.id}`;
                        for (const [key, value] of Object.entries(ch))
                        {
                            this.queueDelta(`${chPath}.${key}`, value);

                            if (plugin.rgbMetas.hasOwnProperty(key))
                                this.queueMeta(`${chPath}.${key}`, plugin.rgbMetas[key].units, plugin.rgbMetas[key].description);
                        }
                    }
                }    
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
            this.queueUpdate(`${mainPath}.board.hostname`, data.hostname + ".local", "", "Hostname of the board");
            this.queueUpdate(`${mainPath}.board.use_ssl`, data.use_ssl, "", "Whether the app uses SSL or not");
            this.queueMeta(`${mainPath}.board.uptime`, "S", "Seconds since the last reboot");

            //some boards don't have this.
            if (data.bus_voltage)
                this.queueMeta(`${mainPath}.board.uuid`, "V", "Supply voltage to the board.");

            //common handler for config and update
            this.queueDeltasAndUpdates(data);

            //actually send them off now.
            this.sendUpdates();
        }

        yb.handleUpdate = function (data)
        {
            if (!this.config)
                return;

            //console.log(JSON.stringify(data));

            let mainPath = this.getMainBoardPath();

            //some boards don't have this.
            if (data.bus_voltage)
                this.queueUpdate(`${mainPath}.board.bus_voltage`, data.bus_voltage, 'V', "Bus supply voltage");

            //store our uptime
            if (data.uptime)
                this.queueUpdate(`${mainPath}.board.uptime`, data.uptime, "S", "Uptime since the last reboot");

            //common handler for config and update
            this.queueDeltasAndUpdates(data);

            //actually send them off now.
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
            this.send(value, true);

            return { state: 'COMPLETED', statusCode: 200 };
        }
    
        return yb;
    }

    return plugin;
};