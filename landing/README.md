# صفحات الانزال — إيفرست العقارية

صفحة انزال (landing page) للمشاريع الجديدة في الساحل الشمالي والإسكندرية.
مبنية على [AstroWind](https://github.com/onwidget/astrowind) (Astro 7 + Tailwind v4)،
معدّلة عربي RTL بالكامل.

## التشغيل

```bash
cd landing
npm install
npm run dev      # http://localhost:4321
npm run build    # ناتج ثابت في dist/
npm run preview  # معاينة الناتج
```

## اللي اتغير عن القالب الأصلي

| الحاجة | التفاصيل |
| --- | --- |
| اللغة والاتجاه | `i18n.language: ar` + `textDirection: rtl` في `src/config.yaml` |
| الخط | Cairo Variable (عربي + لاتيني)، محمّل محلياً من `@fontsource-variable/cairo` — مش من الشبكة وقت البناء |
| الألوان | كحلي `rgb(11 42 74)` + ذهبي `rgb(197 160 89)` في `src/components/CustomStyles.astro` |
| الصفحات | كل صفحات الديمو (`homes/`, `landing/`, about, pricing, services) اتشالت |
| المدونة | متعطّلة في الكونفج — تتفعّل لما يبقى فيه محتوى عربي |
| الهيدر | شريط الإعلان و RSS وزرار الثيم اتشالوا |
| القائمة | `src/navigation.ts` — كلها أنكور جوه الصفحة عشان الزائر ما يخرجش قبل ما يسيب بياناته |

## اللي لسه ناقص

- **صور المشروع**: `src/assets/images/hero-image.png` لسه صورة الديمو.
- **فورم الليدز**: فورم القالب شكلي بس — مفيهوش `action`. لازم يتوصّل بـ Supabase
  أو أي endpoint عشان البيانات تتسجّل.
- **بيانات المشروع**: الأرقام والأسعار في `src/pages/index.astro` كلها مبدئية.
- **الشعار**: `src/components/Logo.astro` نص عادي لحد ما يتحط SVG الشعار الرسمي.
- **رقم الواتساب**: `wa.me/20XXXXXXXXXX` في `src/navigation.ts` و `src/pages/index.astro`.
- **Google Analytics**: `analytics.vendors.googleAnalytics.id` في `src/config.yaml`.

## نتيجة Lighthouse

آخر قياس على ناتج `npm run build`:

| | ديسكتوب | موبايل |
| --- | --- | --- |
| Performance | 100 | 98 |
| Accessibility | 100 | 100 |
| Best Practices | 100 | 100 |
| SEO | 100 | 100 |

## أداة التدقيق

فيه `.mcp.json` في جذر الريبو بيسجّل `lighthouse-mcp`. في Claude Code تقدر
تقول "دقّق الصفحة دي" وهو يشغّل Lighthouse ويرجّع الدرجات و Core Web Vitals.
المرة الأولى Claude Code هيسألك توافق على السيرفر.
