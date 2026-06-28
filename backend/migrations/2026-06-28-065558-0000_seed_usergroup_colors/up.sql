-- Seed chat_group_color / chat_group_color_dark for existing usergroups.
-- Data-only migration: colors should persist even if this migration is rolled back.
INSERT INTO public.usergroup_extra (groupid, chat_group_color, chat_group_color_dark) VALUES
    (57, '#6fb1d5', '#6fb1d5'),
    (56, '#F4A460', '#F4A460'),
    (53, '#F4A460', '#F4A460'),
    (31, '#F4A460', '#F4A460'),
    (30, '#F4A460', '#F4A460'),
    (20, '#F4A460', '#F4A460'),
    (50, '#A380C8', '#A380C8'),
    (18, '#A380DC', '#A380DC'),
    (17, '#A380DC', '#A380DC'),
    (16, '#A380DC', '#A380DC'),
    (15, '#4169E1', '#4169E1'),
    (14, '#4169E1', '#4169E1'),
    (13, '#202020', '#202020'),
    (12, '#202020', '#202020'),
    (11, '#202020', '#202020'),
    (10, '#808080', '#808080'),
    (9,  '#808080', '#808080'),
    (8,  '#808080', '#808080'),
    (7,  '#808080', '#808080'),
    (6,  '#808080', '#808080'),
    (5,  '#808080', '#808080'),
    (4,  '#808080', '#808080'),
    (54, '#F15151', '#F15151'),
    (52, '#F15151', '#F15151'),
    (48, '#F15151', '#F15151'),
    (3,  '#F15151', '#F15151'),
    (2,  '#F15151', '#F15151'),
    (1,  '#F15151', '#F15151')
ON CONFLICT (groupid) DO UPDATE SET
    chat_group_color = EXCLUDED.chat_group_color,
    chat_group_color_dark = EXCLUDED.chat_group_color_dark;
