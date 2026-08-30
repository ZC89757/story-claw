import bpy


scene = bpy.context.scene
scene.render.engine = "CYCLES"
addon = bpy.context.preferences.addons.get("cycles")
if addon is None:
    raise RuntimeError("Cycles preferences add-on is unavailable")

preferences = addon.preferences
available = preferences.bl_rna.properties["compute_device_type"].enum_items.keys()
print("CYCLES_BACKENDS=" + ",".join(available), flush=True)
for backend in ("OPTIX", "CUDA"):
    try:
        preferences.compute_device_type = backend
        preferences.get_devices()
        devices = [f"{device.name}|{device.type}|{device.use}" for device in preferences.devices]
        print(f"{backend}_DEVICES=" + ";".join(devices), flush=True)
    except Exception as exc:
        print(f"{backend}_ERROR={exc}", flush=True)
