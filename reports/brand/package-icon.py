from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parent
sizes = [16, 24, 32, 48, 64, 128, 256]
icon = Image.open(root / 'utrainerbuddy-icon-256.png')
icon.save(root / 'utrainerbuddy-icon.ico', format='ICO', sizes=[(n, n) for n in sizes],
          append_images=[Image.open(root / f'utrainerbuddy-icon-{n}.png') for n in sizes[:-1]])

canvas = Image.new('RGB', (1200, 840), '#F7F8FC')
draw = ImageDraw.Draw(canvas)
fonts = Path('C:/Windows/Fonts')
def font(size, bold=False):
    return ImageFont.truetype(str(fonts / ('msyhbd.ttc' if bold else 'msyh.ttc')), size)

draw.text((70, 44), 'uTrainerBuddy  /  APP ICON', font=font(17), fill='#6574A7')
draw.line((70, 88, 1130, 88), fill='#E1E5F0', width=1)
hero = Image.open(root / 'utrainerbuddy-icon-512.png').resize((400, 400), getattr(Image, 'Resampling', Image).LANCZOS)
canvas.paste(hero, (70, 128), hero)
draw.text((550, 157), 'uTrainerBuddy', font=font(46, True), fill='#283451')
draw.text((550, 226), '更懂训练的智能伙伴', font=font(25), fill='#68738D')
for y, heading, description in [
    (313, 'U 形轮廓', '品牌首字母，也是一个友好的微笑'),
    (381, '向上箭头', '模型训练、持续优化与进步'),
    (449, '薄荷色双眼', '让专业工具保留伙伴的温度'),
]:
    draw.text((550, y), heading, font=font(19, True), fill='#34415E')
    draw.text((550, y + 29), description, font=font(17), fill='#78839A')

draw.line((70, 568, 1130, 568), fill='#E1E5F0', width=1)
draw.text((70, 596), '小尺寸识别', font=font(18, True), fill='#34415E')
for x, size in zip([290, 485, 640, 780, 910, 1030], [128, 64, 48, 32, 24, 16]):
    image = Image.open(root / f'utrainerbuddy-icon-{size}.png')
    canvas.paste(image, (x - size // 2, 700 - size // 2), image)
    draw.text((x, 784), f'{size} px', font=font(14), fill='#78839A', anchor='mm')
canvas.save(root / 'utrainerbuddy-icon-preview.png')

with Image.open(root / 'utrainerbuddy-icon.ico') as output:
    assert output.ico.sizes() == {(n, n) for n in sizes}
for size in [1024, 512, 256, 128, 64, 48, 32, 24, 16]:
    with Image.open(root / f'utrainerbuddy-icon-{size}.png') as output:
        assert output.size == (size, size)
        assert output.mode == 'RGBA'
        assert output.getpixel((0, 0))[3] == 0
print('Verified transparent PNG exports and all seven ICO sizes; preview board saved.')
