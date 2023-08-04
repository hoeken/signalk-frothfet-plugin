# signalk-yarrboard-plugin

SignalK plugin for interfacing with [Yarrboard](https://github.com/hoeken/yarrboard)

## Setup

Add your board hosts and configure login info in the plugin preferences

## Data Format

SignalK path formats are as below:

* electrical.yarrboard.{boardname}.board.* - board level info
* electrical.yarrboard.{boardname}.channel.{id}.* - channel level info

The plugin also provides PUT endpoints on the following paths:

* electrical.yarrboard.{boardname}.control - passes raw json to the websocket, but does not return any response.

See the <a href="https://github.com/hoeken/yarrboard#protocol">protocol documentation</a> for more information on format.  Login and auth will already be handled for you by SignalK.
