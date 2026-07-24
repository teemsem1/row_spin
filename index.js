const { Client, GatewayIntentBits, Collection, EmbedBuilder, REST, Routes, SlashCommandBuilder } = require('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers] });
require('dotenv').config();
const fs = require('fs');

const POINTS_FILE = './points.json';
const SEEN_FILE = './seen.json'; // يحفظ كل الأعضاء اللي سبق ودخلوا السيرفر (حتى لو نقاطهم صفر) عشان نمنع تكرار النقطة لو طلعوا ودخلوا

// أقل عمر مسموح للحساب حتى يُحسب لصاحب الدعوة (3 أسابيع = 21 يوم)
const MIN_ACCOUNT_AGE_MS = 21 * 24 * 60 * 60 * 1000;

function loadJSON(path) {
    if (fs.existsSync(path)) {
        const data = JSON.parse(fs.readFileSync(path, 'utf8'));
        return new Map(Object.entries(data));
    }
    return new Map();
}
function saveJSON(path, map) {
    const obj = Object.fromEntries(map);
    fs.writeFileSync(path, JSON.stringify(obj, null, 2));
}

function loadPoints() { return loadJSON(POINTS_FILE); }
function savePoints(map) { saveJSON(POINTS_FILE, map); }

function loadSeen() { return loadJSON(SEEN_FILE); }
function saveSeen(map) { saveJSON(SEEN_FILE, map); }

const invites = new Map();
const userPoints = loadPoints();
const seenMembers = loadSeen(); // يحفظ كل عضو دخل السيرفر ولو مرة (بغض النظر عن نقاطه)

const inviteLogChannelId = '1512876323087978628';
const prizeLogChannelId = '1512876352246644839';

client.once('ready', async () => {
    console.log(`${client.user.tag} جاهز!`);
    const guild = client.guilds.cache.first();
    if (!guild) return console.log('لم يتم العثور على خادم.');
    const guildInvites = await guild.invites.fetch();
    guildInvites.forEach(invite => {
        invites.set(invite.code, invite.uses || 0);
    });
    console.log('تم حفظ الدعوات الحالية.');

    // نجيب كل الأعضاء الموجودين حالياً بالسيرفر ونسجلهم كـ "شفناهم من قبل"
    // عشان أي عضو موجود أصلاً (حتى لو طلع ودخل بدعوة جديدة بعدين) ما يُحسب له نقطة
    // النقاط بتنحسب فقط لعضو جديد كلياً ما كان بالسيرفر أبداً
    try {
        const allMembers = await guild.members.fetch();
        let addedCount = 0;
        allMembers.forEach(m => {
            if (m.user.bot) return;
            if (!seenMembers.has(m.id)) {
                seenMembers.set(m.id, true);
                addedCount++;
            }
        });
        if (addedCount > 0) saveSeen(seenMembers);
        console.log(`تم فحص الأعضاء الحاليين وتسجيل ${addedCount} عضو جديد في قائمة "شفناهم من قبل" (المجموع: ${seenMembers.size}).`);
    } catch (err) {
        console.error('خطأ أثناء جلب الأعضاء الحاليين:', err);
    }

    const commands = [
        new SlashCommandBuilder()
            .setName('reset-points')
            .setDescription('إعادة تعيين نقاط عضو إلى 0')
            .addUserOption(option =>
                option.setName('user')
                    .setDescription('العضو المراد إعادة تعيين نقاطه')
                    .setRequired(true)
            )
            .toJSON(),
        new SlashCommandBuilder()
            .setName('reset-all-points')
            .setDescription('إعادة تعيين نقاط جميع الأعضاء إلى 0')
            .toJSON(),
        new SlashCommandBuilder()
            .setName('add-points')
            .setDescription('إضافة نقاط لعضو')
            .addUserOption(option =>
                option.setName('user')
                    .setDescription('العضو المراد إضافة نقاط له')
                    .setRequired(true)
            )
            .addIntegerOption(option =>
                option.setName('amount')
                    .setDescription('عدد النقاط المراد إضافتها')
                    .setRequired(true)
                    .setMinValue(1)
            )
            .toJSON(),
        new SlashCommandBuilder()
            .setName('add-points-user')
            .setDescription('إضافة نقاط لعضو (أمر بديل)')
            .addUserOption(option =>
                option.setName('user')
                    .setDescription('العضو المراد إضافة نقاط له')
                    .setRequired(true)
            )
            .addIntegerOption(option =>
                option.setName('amount')
                    .setDescription('عدد النقاط المراد إضافتها')
                    .setRequired(true)
                    .setMinValue(1)
            )
            .toJSON()
    ];

    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: commands });
    console.log('تم تسجيل أوامر Slash.');
});

client.on('guildMemberAdd', async member => {
    if (member.user.bot) return;
    const guild = member.guild;
    const newInvites = await guild.invites.fetch();
    const channel = guild.channels.cache.get(inviteLogChannelId);

    const usedInvite = newInvites.find(invite => {
        const oldUses = invites.get(invite.code) || 0;
        return invite.uses > oldUses;
    });

    // 0) هل العضو سبق ودخل السيرفر من قبل (بأي طريقة، حتى لو ما قدرنا نتتبع دعوته)؟
    //    نتأكد من هذا *قبل* أي شي، عشان أي عضو "طالع داخل" ما يُحسب له نقطة أبداً
    const alreadySeen = seenMembers.has(member.id);

    // نسجل العضو كـ "شوفناه" فوراً عند كل دخول، بغض النظر هل لقينا الدعوة أو احتسبنا نقطة أو لا
    if (!alreadySeen) {
        seenMembers.set(member.id, true);
        saveSeen(seenMembers);
    }

    if (usedInvite && usedInvite.inviter) {
        const inviter = usedInvite.inviter;

        // 1) هل العضو سبق ودخل السيرفر من قبل؟ (طالع داخل / عضو قديم) => ما يُحسب
        if (alreadySeen) {
            if (channel) channel.send(`⚠️ <@${inviter.id}> هذا العضو <@${member.id}> سبق دخل السيرفر من قبل، لن تحصل على نقاط.`);
        } else {
            // 2) هل عمر حساب العضو أقل من 3 أسابيع؟ (حساب وهمي/جديد) => ما يُحسب
            const accountAge = Date.now() - member.user.createdTimestamp;
            if (accountAge < MIN_ACCOUNT_AGE_MS) {
                if (channel) channel.send(`⚠️ <@${inviter.id}> حساب العضو <@${member.id}> عمره أقل من 3 أسابيع (حساب جديد/مشتبه به)، لن تحصل على نقاط.`);
            } else {
                // عضو جديد فعلاً وحسابه قديم بما فيه الكفاية => يُحسب
                const currentPoints = userPoints.get(inviter.id) || 0;
                userPoints.set(inviter.id, currentPoints + 1);
                savePoints(userPoints);
                if (channel) channel.send(`✅ <@${inviter.id}> دعوت <@${member.id}> إلى السيرفر! نقاطك الآن: ${currentPoints + 1} 🔥`);
            }
        }
    }

    newInvites.forEach(invite => {
        invites.set(invite.code, invite.uses || 0);
    });
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;

    if (message.content.startsWith('+add-points')) {
        if (!message.member.permissions.has('ManageGuild')) return message.reply('❌ ليس لديك صلاحية استخدام هذا الأمر.');
        const args = message.content.split(' ');
        const member = message.mentions.members.first();
        const pointsToAdd = parseInt(args[2], 10);
        if (!member || isNaN(pointsToAdd)) return message.reply('❌ صيغة الأمر غير صحيحة. استخدم: `+add-points @mentionUser عدد_النقاط`');
        const currentPoints = userPoints.get(member.id) || 0;
        userPoints.set(member.id, currentPoints + pointsToAdd);
        savePoints(userPoints);
        return message.reply(`✅ تم إضافة ${pointsToAdd} نقطة لـ <@${member.id}>. النقاط الحالية: ${currentPoints + pointsToAdd}`);
    }

    if (message.content.startsWith('+points')) {
        const member = message.mentions.members.first() || message.member;
        const currentPoints = userPoints.get(member.id) || 0;
        return message.reply(`📊 نقاط <@${member.id}>: ${currentPoints}`);
    }

    if (message.content === '+spin') {
        const userPointsCount = userPoints.get(message.author.id) || 0;
        if (userPointsCount < 1) return message.reply('❌ تحتاج على الأقل إلى 1 دعوة لاستخدام عجلة الحظ العادية!');
        const embed = new EmbedBuilder()
            .setTitle('🎉 لعبة عجلة الحظ 🎉')
            .setDescription('اختر نوع العجلة التي تريد اللعب بها:')
            .addFields(
                { name: '🎡 عجلة الحظ العادية', value: 'يتطلب 1 نقطة' },
                { name: '🔥 عجلة الحظ السوبر', value: 'يتطلب 2 نقاط' }
            )
            .setColor('Blue');
        const row = {
            type: 1,
            components: [
                { type: 2, label: 'لف العجلة العادية', style: 1, custom_id: 'normal_spin' },
                { type: 2, label: 'لف العجلة السوبر', style: 4, custom_id: 'super_spin' }
            ]
        };
        return message.reply({ embeds: [embed], components: [row] });
    }
});

client.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand() && interaction.commandName === 'reset-points') {
        if (!interaction.member.permissions.has('Administrator')) {
            return interaction.reply({ content: '❌ ليس لديك صلاحية استخدام هذا الأمر.', ephemeral: true });
        }
        const target = interaction.options.getUser('user');
        userPoints.set(target.id, 0);
        savePoints(userPoints);
        return interaction.reply({ content: `✅ تم إعادة تعيين نقاط <@${target.id}> إلى 0.`, ephemeral: true });
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'reset-all-points') {
        if (!interaction.member.permissions.has('Administrator')) {
            return interaction.reply({ content: '❌ ليس لديك صلاحية استخدام هذا الأمر.', ephemeral: true });
        }
        for (const key of userPoints.keys()) {
            userPoints.set(key, 0);
        }
        savePoints(userPoints);
        return interaction.reply({ content: `✅ تم إعادة تعيين نقاط جميع الأعضاء إلى 0.`, ephemeral: true });
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'add-points') {
        if (!interaction.member.permissions.has('Administrator')) {
            return interaction.reply({ content: '❌ ليس لديك صلاحية استخدام هذا الأمر.', ephemeral: true });
        }
        const target = interaction.options.getUser('user');
        const amount = interaction.options.getInteger('amount');
        const currentPoints = userPoints.get(target.id) || 0;
        userPoints.set(target.id, currentPoints + amount);
        savePoints(userPoints);
        return interaction.reply({ content: `✅ تم إضافة ${amount} نقطة لـ <@${target.id}>. نقاطه الآن: ${currentPoints + amount}`, ephemeral: true });
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'add-points-user') {
        if (!interaction.member.permissions.has('Administrator')) {
            return interaction.reply({ content: '❌ ليس لديك صلاحية استخدام هذا الأمر.', ephemeral: true });
        }
        const target = interaction.options.getUser('user');
        const amount = interaction.options.getInteger('amount');
        const currentPoints = userPoints.get(target.id) || 0;
        userPoints.set(target.id, currentPoints + amount);
        savePoints(userPoints);
        return interaction.reply({ content: `✅ تم إضافة ${amount} نقطة لـ <@${target.id}>. نقاطه الآن: ${currentPoints + amount}`, ephemeral: true });
    }

    if (!interaction.isButton()) return;
    const userPointsCount = userPoints.get(interaction.user.id) || 0;
    const prizeChannel = interaction.guild.channels.cache.get(prizeLogChannelId);

    if (interaction.customId === 'normal_spin') {
        if (userPointsCount < 1) return interaction.reply({ content: '❌ ليس لديك نقاط كافية.', ephemeral: true });
        userPoints.set(interaction.user.id, userPointsCount - 1);
        savePoints(userPoints);
        const prize = getRandomPrize('normal');
        if (prizeChannel) prizeChannel.send(`> 🥳 مبروك <@${interaction.user.id}>! لقد فزت بـ **${prize}** 🏆`);
        return interaction.reply(`🎉 مبروك <@${interaction.user.id}>! لقد فزت بـ **${prize}**! 🏆`);
    }

    if (interaction.customId === 'super_spin') {
        if (userPointsCount < 2) return interaction.reply({ content: '❌ ليس لديك نقاط كافية.', ephemeral: true });
        userPoints.set(interaction.user.id, userPointsCount - 2);
        savePoints(userPoints);
        const prize = getRandomPrize('super');
        if (prizeChannel) prizeChannel.send(`> 🥳 مبروك <@${interaction.user.id}>! لقد فزت بـ **${prize}** 🏆`);
        return interaction.reply(`🎉 مبروك <@${interaction.user.id}>! لقد فزت بـ **${prize}**! 🏆`);
    }
});

const prizes = {
    normal: [
        { prize: '200k', chance: 50 },
        { prize: '500k', chance: 20 },
        { prize: '750k', chance: 1 },
        { prize: '1M', chance: 0.1 },
        { prize: '10m', chance: 0.00001 },
    ],
    super: [
        { prize: '200k', chance: 50 },
        { prize: '5 rob', chance: 30 },
        { prize: '1o rob', chance: 7 },
        { prize: '1m', chance: 1 },
        { prize: '1m', chance: 0.000000001 },
        { prize: '10m', chance: 0.01 },
        { prize: '8m', chance: 0.00001 },
        { prize: '2m', chance: 0.00001 },
        { prize: '5m', chance: 0.00001 }
    ]
};

function getRandomPrize(type) {
    const list = prizes[type];
    const total = list.reduce((sum, item) => sum + item.chance, 0);
    const random = Math.random() * total;
    let cumulative = 0;
    for (const item of list) {
        cumulative += item.chance;
        if (random <= cumulative) return item.prize;
    }
    return list[list.length - 1].prize;
}

client.login(process.env.TOKEN);
