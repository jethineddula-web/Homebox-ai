"""Homebox bridge: lets the Homebox app run Python inside this program.

Works in Maya, Blender, Houdini, 3ds Max, Cinema 4D, Nuke, Unreal Engine and Substance 3D Painter.
Start it from the program's Python console (Homebox -> Apps shows the exact line):

    import runpy; runpy.run_path(r"C:/Users/you/.homebox/bridges/homebox_bridge.py")

It listens on 127.0.0.1 only, and every request must carry the secret from
~/.homebox/bridge_token, so websites and other computers cannot use it.
Every step is sent by Homebox only after you approve it there.
"""
import builtins
import contextlib
import hmac
import io
import json
import os
import queue
import socket
import sys
import threading
import time
import traceback

bl_info = {  # lets Blender install this file as an add-on
    "name": "Homebox bridge",
    "author": "Jethin Production",
    "version": (1, 0, 0),
    "blender": (2, 80, 0),
    "category": "System",
    "description": "Lets the Homebox app run approved Python steps in Blender",
}

PORTS = {'maya': 7017, 'blender': 7010, 'houdini': 7011, 'max': 7012, 'c4d': 7013, 'nuke': 7014, 'unreal': 7015, 'painter': 7016}
NAMES = {'maya': 'Maya', 'blender': 'Blender', 'houdini': 'Houdini', 'max': '3ds Max', 'c4d': 'Cinema 4D', 'nuke': 'Nuke',
         'unreal': 'Unreal Engine', 'painter': 'Substance 3D Painter'}
MAX_OUTPUT = 20000
UNDO_NAME = 'Homebox AI step'


def _detect():
    for mod, app in (('maya.cmds', 'maya'), ('bpy', 'blender'), ('hou', 'houdini'), ('pymxs', 'max'), ('c4d', 'c4d'),
                     ('nuke', 'nuke'), ('unreal', 'unreal'), ('substance_painter', 'painter')):
        try:
            __import__(mod)
            return app
        except Exception:
            pass
    return None


def _homebox_dirs():
    dirs = []
    here = globals().get('__file__')
    if here:
        dirs.append(os.path.dirname(os.path.dirname(os.path.abspath(here))))
    for base in (os.environ.get('USERPROFILE'), os.environ.get('HOME'), os.path.expanduser('~')):
        if base:
            dirs.append(os.path.join(base, '.homebox'))
    return dirs


def _read_token():
    for d in _homebox_dirs():
        try:
            with open(os.path.join(d, 'bridge_token'), encoding='utf-8') as f:
                t = f.read().strip()
            if t:
                return t
        except OSError:
            pass
    return ''


def _qt_core():
    for name in ('PySide6', 'PySide2', 'PyQt5', 'PyQt6'):
        try:
            return __import__(name + '.QtCore', fromlist=['QtCore'])
        except Exception:
            pass
    raise RuntimeError('Homebox bridge: no Qt found in this program, so it cannot run steps on the main thread.')


def _app_version(app):
    try:
        if app == 'maya':
            import maya.cmds as cmds
            return str(cmds.about(version=True))
        if app == 'blender':
            import bpy
            return bpy.app.version_string
        if app == 'houdini':
            import hou
            return hou.applicationVersionString()
        if app == 'max':
            import pymxs
            return str(int(pymxs.runtime.maxVersion()[0] / 1000) + 1998)
        if app == 'c4d':
            import c4d
            return str(c4d.GetC4DVersion())
        if app == 'nuke':
            import nuke
            return nuke.NUKE_VERSION_STRING
        if app == 'unreal':
            import unreal
            return unreal.SystemLibrary.get_engine_version()
        if app == 'painter':
            import substance_painter.application as spa
            return str(spa.version())
    except Exception:
        pass
    return ''


def _namespace(app, sandbox):
    g = {'__name__': '__main__', 'SANDBOX': sandbox}
    if app == 'maya':
        import maya.cmds as cmds
        g['cmds'] = cmds
    elif app == 'blender':
        import bpy
        import mathutils
        g.update(bpy=bpy, mathutils=mathutils, C=bpy.context, D=bpy.data)
    elif app == 'houdini':
        import hou
        g['hou'] = hou
    elif app == 'max':
        import pymxs
        g.update(pymxs=pymxs, rt=pymxs.runtime)
    elif app == 'c4d':
        import c4d
        g.update(c4d=c4d, doc=c4d.documents.GetActiveDocument())
    elif app == 'nuke':
        import nuke
        g['nuke'] = nuke
    elif app == 'unreal':
        import unreal
        g['unreal'] = unreal
    elif app == 'painter':
        import substance_painter
        for sub in ('application', 'project', 'textureset', 'layerstack', 'export', 'resource', 'baking', 'js', 'logging'):
            try:
                __import__('substance_painter.' + sub)
            except Exception:
                pass
        g['substance_painter'] = substance_painter
    return g


@contextlib.contextmanager
def _undo_group(app, g):
    """Make one AI step one undo step where the program allows it."""
    if app == 'maya':
        import maya.cmds as cmds
        cmds.undoInfo(openChunk=True, chunkName=UNDO_NAME)
        try:
            yield
        finally:
            cmds.undoInfo(closeChunk=True)
    elif app == 'houdini':
        import hou
        with hou.undos.group(UNDO_NAME):
            yield
    elif app == 'max':
        import pymxs
        with pymxs.undo(True, UNDO_NAME):
            yield
    elif app == 'unreal':
        import unreal
        with unreal.ScopedEditorTransaction(UNDO_NAME):
            yield
    elif app == 'nuke':
        import nuke
        undo = nuke.Undo()
        undo.begin(UNDO_NAME)
        try:
            yield
        finally:
            undo.end()
    elif app == 'c4d':
        import c4d
        doc = g.get('doc')
        if doc is not None:
            doc.StartUndo()
        try:
            yield
        finally:
            if doc is not None:
                doc.EndUndo()
            c4d.EventAdd()
    else:
        yield
        if app == 'blender':
            try:
                import bpy
                bpy.ops.ed.undo_push(message=UNDO_NAME)
            except Exception:
                pass


class Bridge:
    def __init__(self, app, port, wake=None):
        self.app = app
        self.port = port
        self.wake = wake
        self.token = _read_token()
        self.version = _app_version(app)
        self.jobs = queue.Queue()
        self.busy = False
        self.server = None
        self.pump = None

    # ---- network (background threads) ----
    def listen(self):
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.bind(('127.0.0.1', self.port))
        srv.listen(8)
        self.server = srv
        threading.Thread(target=self._accept, name='homebox-bridge', daemon=True).start()

    def _accept(self):
        while True:
            try:
                conn, _ = self.server.accept()
            except OSError:
                return
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()

    def _handle(self, conn):
        try:
            conn.settimeout(15)
            data = b''
            while b'\n' not in data:
                chunk = conn.recv(65536)
                if not chunk:
                    break
                data += chunk
                if len(data) > 8_000_000:
                    raise ValueError('request too large')
            req = json.loads(data.decode('utf-8'))
            if not self._authorized(str(req.get('token', ''))):
                return self._reply(conn, {'ok': False, 'output': 'Homebox bridge: wrong secret. Restart the bridge after reinstalling Homebox.'})
            if req.get('op') == 'ping':
                return self._reply(conn, {'ok': True, 'app': self.app, 'name': NAMES.get(self.app, self.app), 'version': self.version})
            timeout = min(max(float(req.get('timeout') or 120), 5), 600)
            job = {'code': str(req.get('code', '')), 'sandbox': str(req.get('sandbox', '')),
                   'deadline': time.time() + timeout, 'done': threading.Event(), 'result': None}
            self.jobs.put(job)
            if self.wake:
                try:
                    self.wake()
                except Exception:
                    pass
            conn.settimeout(None)
            if not job['done'].wait(timeout + 5):
                job['deadline'] = 0
                return self._reply(conn, {'ok': False, 'output': '%s did not run the step in time. A dialog box may be open, or it is busy.' % NAMES.get(self.app, self.app)})
            self._reply(conn, job['result'])
        except Exception as e:
            try:
                self._reply(conn, {'ok': False, 'output': 'Homebox bridge error: %s' % e})
            except Exception:
                pass
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def _authorized(self, token):
        if not self.token:
            self.token = _read_token()
        if self.token and hmac.compare_digest(token, self.token):
            return True
        fresh = _read_token()  # Homebox may have made a new secret
        if fresh and fresh != self.token and hmac.compare_digest(token, fresh):
            self.token = fresh
            return True
        return False

    @staticmethod
    def _reply(conn, obj):
        conn.sendall((json.dumps(obj) + '\n').encode('utf-8'))

    # ---- main thread ----
    def drain(self):
        if self.busy:
            return
        self.busy = True
        try:
            while True:
                try:
                    job = self.jobs.get_nowait()
                except queue.Empty:
                    return
                if time.time() > job['deadline']:
                    job['result'] = {'ok': False, 'output': 'The step expired before it could run.'}
                else:
                    job['result'] = self.run(job['code'], job['sandbox'])
                job['done'].set()
        finally:
            self.busy = False

    def run(self, code, sandbox):
        buf = io.StringIO()
        old_out, old_err = sys.stdout, sys.stderr
        sys.stdout = sys.stderr = buf
        ok = True
        try:
            g = _namespace(self.app, sandbox)
            with _undo_group(self.app, g):
                exec(compile(code, 'ai_step.py', 'exec'), g)
        except Exception:
            ok = False
            etype, err, tb = sys.exc_info()
            # hide the bridge's own frame; a typo (SyntaxError) only needs its own message
            traceback.print_exception(etype, err, None if issubclass(etype, SyntaxError) else (tb.tb_next or tb))
        finally:
            sys.stdout, sys.stderr = old_out, old_err
        out = buf.getvalue()
        if len(out) > MAX_OUTPUT:
            out = out[:4000] + '\n...[output cut]...\n' + out[-(MAX_OUTPUT - 4000):]
        if ok and not out.strip():
            out = '(ran OK, no output - use print() to report things)'
        return {'ok': ok, 'output': out}

    def install_pump(self):
        if self.app == 'blender':
            import bpy

            def tick():
                self.drain()
                return 0.1
            bpy.app.timers.register(tick, persistent=True)
            self.pump = tick
        elif self.app == 'unreal':
            import unreal
            self.pump = unreal.register_slate_post_tick_callback(lambda dt: self.drain())
        elif self.app == 'c4d':
            pass  # homebox_c4d.pyp calls drain() from Cinema 4D's main thread
        else:
            QtCore = _qt_core()
            timer = QtCore.QTimer()
            timer.setInterval(100)
            timer.timeout.connect(self.drain)
            timer.start()
            self.pump = timer

    def stop(self):
        try:
            if self.server:
                self.server.close()
        except Exception:
            pass
        try:
            if self.app == 'blender' and self.pump:
                import bpy
                if bpy.app.timers.is_registered(self.pump):
                    bpy.app.timers.unregister(self.pump)
            elif self.app == 'unreal' and self.pump is not None:
                import unreal
                unreal.unregister_slate_post_tick_callback(self.pump)
            elif self.pump is not None and hasattr(self.pump, 'stop'):
                self.pump.stop()
        except Exception:
            pass


def start(app=None, wake=None):
    """Start the bridge once per program session. Safe to call again."""
    running = getattr(builtins, '_homebox_bridge', None)
    if running is not None:
        print('Homebox: %s bridge is already listening on port %d' % (NAMES.get(running.app, running.app), running.port))
        return running
    app = app or _detect()
    if app not in PORTS:
        print('Homebox bridge: this program is not supported.')
        return None
    bridge = Bridge(app, PORTS[app], wake)
    try:
        bridge.listen()
    except OSError as e:
        print('Homebox bridge: port %d is busy (%s). Is the bridge already running in another window?' % (PORTS[app], e))
        return None
    bridge.install_pump()
    builtins._homebox_bridge = bridge
    print('Homebox: %s is listening on port %d' % (NAMES[app], PORTS[app]))
    return bridge


def stop():
    bridge = getattr(builtins, '_homebox_bridge', None)
    if bridge is not None:
        bridge.stop()
        del builtins._homebox_bridge
        print('Homebox bridge stopped.')


# Blender add-on / startup script hooks
def register():
    start('blender')


def unregister():
    stop()


# Substance 3D Painter startup plugin hooks
def start_plugin():
    start('painter')


def close_plugin():
    stop()


if __name__ in ('__main__', '<run_path>'):
    start()
