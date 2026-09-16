import { getPermalink } from './utils/permalinks';

// روابط لمّ العملاء المحتملين: كلها أنكور داخل صفحة الانزال نفسها، عشان
// ما نطلّعش الزائر بره الصفحة قبل ما يسيب بياناته.
export const headerData = {
  links: [
    { text: 'عن المشروع', href: getPermalink('/#about') },
    { text: 'المميزات', href: getPermalink('/#features') },
    { text: 'الوحدات', href: getPermalink('/#units') },
    { text: 'أنظمة السداد', href: getPermalink('/#payment') },
    { text: 'الموقع', href: getPermalink('/#location') },
    { text: 'أسئلة شائعة', href: getPermalink('/#faqs') },
  ],
  actions: [{ text: 'احجز معاينة', href: getPermalink('/#contact'), variant: 'primary' }],
};

export const footerData = {
  links: [
    {
      title: 'المشروع',
      links: [
        { text: 'عن المشروع', href: getPermalink('/#about') },
        { text: 'المميزات', href: getPermalink('/#features') },
        { text: 'الوحدات والمساحات', href: getPermalink('/#units') },
        { text: 'أنظمة السداد', href: getPermalink('/#payment') },
      ],
    },
    {
      title: 'إيفرست العقارية',
      links: [
        { text: 'الموقع الرسمي', href: 'https://everest-realestate.net' },
        { text: 'تواصل معنا', href: getPermalink('/#contact') },
      ],
    },
  ],
  secondaryLinks: [],
  socialLinks: [
    { ariaLabel: 'واتساب', icon: 'tabler:brand-whatsapp', href: 'https://wa.me/20XXXXXXXXXX' },
    { ariaLabel: 'فيسبوك', icon: 'tabler:brand-facebook', href: '#' },
    { ariaLabel: 'إنستجرام', icon: 'tabler:brand-instagram', href: '#' },
  ],
  footNote: `
    إيفرست العقارية · جميع الحقوق محفوظة.
  `,
};
