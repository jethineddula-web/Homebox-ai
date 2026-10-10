"""Homebox bridge for Cinema 4D.

Add this folder in Cinema 4D: Preferences -> Plugins -> Add Folder, then restart Cinema 4D.
Steps from Homebox run on Cinema 4D's main thread, one undo step each.
"""
import os
import runpy

import c4d

# From Maxon's range for local/testing plugins. Change it if another plugin uses the same number.
PLUGIN_ID = 1000010
BRIDGE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'homebox_bridge.py')

_bridge = None


class HomeboxMessage(c4d.plugins.MessageData):
    def GetTimer(self):
        return 250  # also check for work a few times a second, in case a wake-up is missed

    def CoreMessage(self, id, bc):
        if _bridge is not None:
            _bridge.drain()
        return True


def PluginMessage(id, data):
    global _bridge
    if id == c4d.C4DPL_PROGRAM_STARTED and _bridge is None:
        _bridge = runpy.run_path(BRIDGE, run_name='homebox_bridge')['start']('c4d', lambda: c4d.SpecialEventAdd(PLUGIN_ID))
        return True
    if id == c4d.C4DPL_ENDPROGRAM and _bridge is not None:
        _bridge.stop()
        return True
    return False


if __name__ == '__main__':
    c4d.plugins.RegisterMessagePlugin(id=PLUGIN_ID, str='Homebox bridge', info=0, dat=HomeboxMessage())
