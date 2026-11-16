// Playwright 测试：加载页面，捕获错误，模拟点击
const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch({
        executablePath: 'C:/Users/xander/AppData/Local/ms-playwright/chromium-1255/chrome-win64/chrome.exe',
        args: ['--no-sandbox']
    });
    const page = await browser.newPage();

    const errors = [];
    const logs = [];

    page.on('console', msg => {
        const text = msg.text();
        logs.push(`[${msg.type()}] ${text}`);
        if (msg.type() === 'error') errors.push(text);
    });
    page.on('pageerror', err => {
        errors.push(`PAGE ERROR: ${err.message}\n${err.stack}`);
    });

    await page.goto('http://localhost:8765/index.html', { waitUntil: 'networkidle' });
    console.log('页面加载完成');

    // 等待启动菜单
    await page.waitForTimeout(500);

    // 点击"新游戏"
    console.log('点击"新游戏"...');
    await page.click('#btnNewGame');
    await page.waitForTimeout(300);

    // 点击第一个国家卡片
    console.log('点击第一个国家卡片...');
    await page.click('.country-card');
    await page.waitForTimeout(1000);

    // 检查是否进入游戏界面
    const gameScreenVisible = await page.isVisible('#gameScreen');
    console.log('游戏界面可见:', gameScreenVisible);

    // 检查面板内容
    const panelHTML = await page.evaluate(() => document.getElementById('panelContent').innerHTML.length);
    console.log('面板内容长度:', panelHTML);

    // 尝试点击面板标签（政治）
    console.log('点击"政治"面板标签...');
    await page.click('.panel-tab[data-panel="politics"]');
    await page.waitForTimeout(300);
    const politicsHTML = await page.evaluate(() => document.getElementById('panelContent').innerHTML.length);
    console.log('政治面板内容长度:', politicsHTML);

    // 检查是否有焦点卡片
    const focusCards = await page.$$eval('.focus-card', els => els.length);
    console.log('焦点卡片数量:', focusCards);

    // 尝试点击第一个焦点
    if (focusCards > 0) {
        console.log('点击第一个焦点...');
        await page.click('.focus-card');
        await page.waitForTimeout(300);
        const logText = await page.evaluate(() => document.getElementById('panelContent').innerHTML.includes('已完成'));
        console.log('焦点点击后面板更新:', logText);
    }

    // 尝试点击速度按钮
    console.log('点击速度按钮(1级)...');
    await page.click('.speed-btn[data-speed="1"]');
    await page.waitForTimeout(200);

    // 尝试点击科技标签
    console.log('点击"科技"面板标签...');
    await page.click('.panel-tab[data-panel="tech"]');
    await page.waitForTimeout(300);
    const techCards = await page.$$eval('.tech-card', els => els.length);
    console.log('科技卡片数量:', techCards);

    // 尝试点击科技槽
    const techSlots = await page.$$eval('.tech-slot-item[data-tech-slot]', els => els.length);
    console.log('空闲科技槽数量:', techSlots);
    if (techSlots > 0) {
        console.log('点击科技槽...');
        await page.click('.tech-slot-item[data-tech-slot="0"]');
        await page.waitForTimeout(300);
    }

    // 检查日期是否在推进
    await page.waitForTimeout(2000);
    const dateText = await page.textContent('#dateText');
    console.log('当前日期:', dateText);

    console.log('\n=== 控制台错误 ===');
    if (errors.length === 0) {
        console.log('无错误');
    } else {
        for (const e of errors) console.log(e);
    }

    console.log('\n=== 控制台日志 ===');
    for (const l of logs) console.log(l);

    await browser.close();
    process.exit(errors.length > 0 ? 1 : 0);
})();
