# -*- coding: utf-8 -*-
import json, base64

IMG_PATH = r"C:\Users\ZhangChi\Desktop\改写漫剧\story-claw\workspace\规则怪谈 - 副本\ep03\render_四人宿舍室内\g00_p02.png"
TEMPLATE = "video_ltx2_3_i2v_PRESUB.json"
OUT      = "_bench_workflow.json"

PROMPT = (
    "固定镜头。男生站在卧室床边，双手插在裤兜里，目光直视镜头，"
    "语气低沉而坚定地开口说出台词：\"这间屋子有几条规矩，你搬进来的第一天就该记住："
    "晚上十一点后不要回头看镜子，走廊的灯滋滋响的时候千万别去修，还有，"
    "不管听到谁在敲你的门，没有听清是三下敲门声，就绝对不能开门。\""
    "说完他微微皱眉，嘴唇抿紧，眼神中透出一丝不安，身体保持静止。"
    "No background music or ambient sound. No subtitles or text overlays."
)

FPS = 25
DURATION_SEC = 10
LTX_FRAME_STEP = 8


def duration_to_frames(dur_sec, fps):
    ideal = dur_sec * fps
    k = max(1, round((ideal - 1) / LTX_FRAME_STEP))
    return k * LTX_FRAME_STEP + 1


def main():
    wf = json.load(open(TEMPLATE, encoding="utf-8"))
    img_b64 = base64.b64encode(open(IMG_PATH, "rb").read()).decode()

    frames = duration_to_frames(DURATION_SEC, FPS)

    wf["324"]["inputs"]["base64_data"] = img_b64
    wf["320:319"]["inputs"]["value"] = PROMPT
    wf["320:312"]["inputs"]["value"] = 720   # width  (9:16，匹配参考图 1024x1536 竖构图)
    wf["320:299"]["inputs"]["value"] = 1280  # height
    wf["320:295"]["inputs"]["length"] = frames
    wf["320:305"]["inputs"]["frames_number"] = frames

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(wf, f, ensure_ascii=False)

    print(f"frames={frames}  duration~={frames/FPS:.2f}s  prompt_len={len(PROMPT)}字")
    print(f"written: {OUT}")


if __name__ == "__main__":
    main()
