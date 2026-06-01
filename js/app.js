// 确保 Vue 快速初始化
document.addEventListener('DOMContentLoaded', function () {
    if (typeof Vue !== 'undefined') {
        initializeApp();
    } else {
        // 如果 Vue 未加载，等待
        setTimeout(initializeApp, 100);
    }
});

function initializeApp() {
    if (typeof Vue === 'undefined') return;

    new Vue({
        el: '#app',
        data: {
            // 当前监控的合约 (用户输入)
            currentSymbol: localStorage.getItem('current_symbol') || 'BTCUSDT', // 默认
            inputSymbol: '',

            // WebSocket
            socket: null,
            wsConnected: false,
            wsStatusText: '连接中...',

            // 价格数据 (只存当前)
            currentPrice: null,
            lastTime: '',

            // 静默区间 (最高价、最低价)
            silentMin: null,
            silentMax: null,

            // 时间范围 (东八区)
            timeRangeStartTime: null,
            timeRangeEndTime: null,
            timeRangeEnabled: false,

            // 播报开关
            speakEnabled: true,

            // 播报状态
            isBroadcasting: false,
            broadcastInterval: null,

            // 弹窗
            dialogVisible: false,
            intervalSeconds: 10,

            // 语音
            voiceOptions: [
                { value: 'auto', label: '自动优选(性感中文女声)' },
                { value: 'xiaoxiao', label: '晓晓 (自然年轻)' },
                { value: 'yunxi', label: '云希 (温暖)' },
                { value: 'yunyang', label: '云扬 (专业)' },
                { value: 'huihui', label: '慧慧 (成熟)' },
                { value: 'default', label: '默认中文' }
            ],
            selectedVoice: 'auto',
            currentVoiceName: '自动优选',
            sexyVoice: null,
            speechWoken: false,

            statusMessage: '就绪，点击开始',

            reconnectTimer: null,
            userInterrupted: false,

            // 价格小数位数 (自动检测)
            priceDecimals: 3
        },

        computed: {
            // 格式化价格显示 (根据小数位)
            formatPrice() {
                if (this.currentPrice === null) return '---';
                // 根据小数位动态显示，但最多8位
                return this.currentPrice.toFixed(this.priceDecimals);
            }
        },

        mounted() {
            this.loadFromStorage();
            this.initVoices();
            // 初始化合约连接
            this.inputSymbol = this.currentSymbol;
            this.applySymbol(true); // 静默连接
        },

        methods: {
            // 格式化静默区间显示
            formatSilent(val) {
                if (val === null || val === undefined) return '';
                return val.toFixed(this.priceDecimals);
            },

            // 加载本地存储 (静默区间、间隔、语音)
            loadFromStorage() {
                // 静默区间
                const savedMin = localStorage.getItem('silent_min');
                const savedMax = localStorage.getItem('silent_max');
                if (savedMin !== null) this.silentMin = parseFloat(savedMin);
                if (savedMax !== null) this.silentMax = parseFloat(savedMax);

                // 时间范围
                const savedStartTime = localStorage.getItem('time_range_start');
                const savedEndTime = localStorage.getItem('time_range_end');
                const savedTimeEnabled = localStorage.getItem('time_range_enabled');
                if (savedStartTime !== null) this.timeRangeStartTime = savedStartTime;
                if (savedEndTime !== null) this.timeRangeEndTime = savedEndTime;
                if (savedTimeEnabled !== null) this.timeRangeEnabled = savedTimeEnabled === 'true';

                // 播报开关
                const savedSpeak = localStorage.getItem('speak_enabled');
                if (savedSpeak !== null) this.speakEnabled = savedSpeak === 'true';

                // 间隔
                const savedInterval = localStorage.getItem('interval_seconds');
                if (savedInterval) this.intervalSeconds = parseInt(savedInterval);

                // 语音
                const savedVoice = localStorage.getItem('selected_voice');
                if (savedVoice) this.selectedVoice = savedVoice;
            },

            // 保存静默区间
            saveSilentRange() {
                if (this.silentMin !== null && this.silentMax !== null) {
                    if (this.silentMin < this.silentMax) {
                        localStorage.setItem('silent_min', this.silentMin.toString());
                        localStorage.setItem('silent_max', this.silentMax.toString());
                    } else {
                        this.$message.error('最低价必须小于最高价');
                    }
                } else {
                    // 允许清空
                    if (this.silentMin === null) localStorage.removeItem('silent_min');
                    if (this.silentMax === null) localStorage.removeItem('silent_max');
                }
                // 触发提示更新
            },

            // 应用新合约
            applySymbol(initial = false) {
                let raw = this.inputSymbol.trim().toLowerCase();
                if (!raw) {
                    this.$message.warning('请输入合约名称');
                    return;
                }
                // 去除可能的 USDT 后缀，确保格式正确
                if (!raw.endsWith('usdt')) raw = raw + 'usdt';

                const newSymbol = raw.toUpperCase();
                if (this.currentSymbol === newSymbol && !initial) {
                    this.$message.info('已是当前合约');
                    return;
                }

                this.currentSymbol = newSymbol;
                localStorage.setItem('current_symbol', this.currentSymbol);

                // 重置价格
                this.currentPrice = null;
                this.lastTime = '';

                // 断开旧连接，重新连接
                this.userInterrupted = true;
                if (this.socket) {
                    this.socket.close();
                }
                this.userInterrupted = false;
                this.initWebSocket();

                if (!initial) this.$message.success(`已切换至 ${this.currentSymbol}`);
            },

            // WebSocket 初始化 (只订阅当前合约)
            initWebSocket() {
                if (!this.currentSymbol) return;

                if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
                    return;
                }

                const streamName = `${this.currentSymbol.toLowerCase()}@markPrice`;
                const WS_URL = `wss://fstream.binance.com/market/stream?streams=${streamName}`;

                try {
                    this.socket = new WebSocket(WS_URL);
                } catch (e) {
                    this.wsConnected = false;
                    this.wsStatusText = '连接失败';
                    return;
                }

                this.socket.onopen = () => {
                    this.wsConnected = true;
                    this.wsStatusText = '已连接';
                };

                this.socket.onmessage = (event) => {
                    try {
                        const msg = JSON.parse(event.data);
                        if (msg.stream && msg.data) {
                            const data = msg.data;
                            if (data.p !== undefined) {
                                const price = parseFloat(data.p);
                                if (!isNaN(price)) {
                                    this.currentPrice = price;
                                    // 动态决定小数位: 如果价格小于1则用5位，否则用2位；但也可以根据品种，这里简单处理
                                    if (price < 1) {
                                        this.priceDecimals = 5;
                                    } else if (price < 10) {
                                        this.priceDecimals = 3;
                                    } else {
                                        this.priceDecimals = 2;
                                    }
                                    const eventTime = data.E ? new Date(data.E) : new Date();
                                    this.lastTime = `🕒 ${eventTime.toLocaleTimeString()}`;
                                }
                            }
                        }
                    } catch (err) {
                        console.warn('解析消息失败', err);
                    }
                };

                this.socket.onerror = () => {
                    this.wsConnected = false;
                    this.wsStatusText = '连接错误';
                };

                this.socket.onclose = () => {
                    this.wsConnected = false;
                    this.wsStatusText = '未连接';
                    if (!this.userInterrupted) {
                        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
                        this.reconnectTimer = setTimeout(() => {
                            this.initWebSocket();
                        }, 5000);
                    }
                };
            },

            // 语音初始化
            initVoices() {
                if (!window.speechSynthesis) {
                    this.currentVoiceName = '不支持语音';
                    return;
                }
                this.currentVoiceName = '语音准备中...';
                window.speechSynthesis.onvoiceschanged = () => this.updateVoiceSelection();
                const voices = window.speechSynthesis.getVoices();
                if (voices && voices.length > 0) {
                    this.updateVoiceSelection();
                }
                setTimeout(() => this.updateVoiceSelection(), 500);
            },

            updateVoiceSelection() {
                const voices = window.speechSynthesis.getVoices();
                let selected = null;
                switch (this.selectedVoice) {
                    case 'xiaoxiao': selected = voices.find(v => v.name.includes('Xiaoxiao') || v.name.includes('晓晓')); break;
                    case 'yunxi': selected = voices.find(v => v.name.includes('Yunxi') || v.name.includes('云希')); break;
                    case 'yunyang': selected = voices.find(v => v.name.includes('Yunyang') || v.name.includes('云扬')); break;
                    case 'huihui': selected = voices.find(v => v.name.includes('Huihui') || v.name.includes('慧慧')); break;
                    case 'default': selected = voices.find(v => v.lang.startsWith('zh')); break;
                    case 'auto':
                    default:
                        selected = voices.find(v => v.name.includes('Xiaoxiao') || v.name.includes('晓晓')) ||
                            voices.find(v => v.name.includes('Yunxi') || v.name.includes('云希')) ||
                            voices.find(v => v.name.includes('Yunyang') || v.name.includes('云扬')) ||
                            voices.find(v => v.name.includes('Huihui') || v.name.includes('慧慧')) ||
                            voices.find(v => v.name.includes('Google') && v.lang.startsWith('zh')) ||
                            voices.find(v => v.lang.startsWith('zh'));
                        break;
                }
                if (selected) {
                    this.sexyVoice = selected;
                    this.currentVoiceName = selected.name;
                } else {
                    this.sexyVoice = null;
                    this.currentVoiceName = '使用默认声音';
                }
            },

            wakeSpeech() {
                if (!window.speechSynthesis || this.speechWoken) return;
                try {
                    const test = new SpeechSynthesisUtterance('语音已激活');
                    test.lang = 'zh-CN';
                    test.rate = 1;
                    test.pitch = 1;
                    if (this.sexyVoice) test.voice = this.sexyVoice;
                    test.onend = () => {
                        this.speechWoken = true;
                    };
                    test.onerror = () => {
                        this.speechWoken = true;
                    };
                    window.speechSynthesis.speak(test);
                } catch (e) {
                    console.warn('唤醒语音失败', e);
                    this.speechWoken = true;
                }
            },

            // 判断是否应播报 (价格超出静默区间)
            shouldSpeak() {
                if (!this.speakEnabled) return false;
                if (this.currentPrice === null) return false;

                // 检查时间范围是否启用且在范围内
                if (this.timeRangeEnabled && this.timeRangeStartTime && this.timeRangeEndTime) {
                    if (this.isCurrentTimeInRange()) {
                        // 在时间范围内，忽略价格范围直接播报
                        return true;
                    }
                }

                // 否则按照原有的价格范围逻辑
                if (this.silentMin === null || this.silentMax === null) return true; // 没设区间就播报
                if (this.silentMin >= this.silentMax) return true; // 无效区间也播报

                // 价格在区间内 -> 不播报；在区间外 -> 播报
                return !(this.currentPrice >= this.silentMin && this.currentPrice <= this.silentMax);
            },

            // 检查当前东八区时间是否在指定范围内
            isCurrentTimeInRange() {
                if (!this.timeRangeStartTime || !this.timeRangeEndTime) return false;

                // 获取当前东八区时间
                const now = new Date();
                // 使用 UTC 时间 + 8 小时得到东八区时间
                const utcHours = now.getUTCHours();
                const utcMinutes = now.getUTCMinutes();
                
                let utc8Hours = utcHours + 8;
                let utc8Minutes = utcMinutes;
                
                if (utc8Hours >= 24) {
                    utc8Hours -= 24;
                }

                // 格式化为 HH:mm
                const currentTime = `${String(utc8Hours).padStart(2, '0')}:${String(utc8Minutes).padStart(2, '0')}`;
                const startTime = this.timeRangeStartTime;
                const endTime = this.timeRangeEndTime;

                // 比较时间字符串（因为都是 HH:mm 格式，可以直接比较）
                return currentTime >= startTime && currentTime <= endTime;
            },

            // 播报一轮
            speakRound() {
                if (!this.isBroadcasting) return;

                if (this.currentPrice === null) {
                    this.statusMessage = '等待价格数据...';
                    return;
                }

                if (!this.shouldSpeak()) {
                    this.statusMessage = `价格 ${this.formatPrice} 在静默区间内，不播报`;
                    return;
                }

                // 播报价格文本
                let textForSpeech = this.currentPrice.toFixed(this.priceDecimals);

                // 显示消息
                this.statusMessage = `播报: ${this.currentSymbol} ${this.formatPrice}`;

                // 取消任何正在进行的语音
                window.speechSynthesis.cancel();

                const utterance = new SpeechSynthesisUtterance(textForSpeech);
                utterance.lang = 'zh-CN';
                utterance.rate = 0.9;
                utterance.pitch = 1.1;
                if (this.sexyVoice) {
                    utterance.voice = this.sexyVoice;
                } else {
                    utterance.voice = null;
                }

                utterance.onend = () => {
                    if (this.isBroadcasting) {
                        this.statusMessage = `本轮播完 (${this.intervalSeconds}秒后下一轮)`;
                    }
                };
                utterance.onerror = () => {
                    if (this.isBroadcasting) {
                        this.statusMessage = '播报出错';
                    }
                };
                window.speechSynthesis.speak(utterance);
            },

            // 开始
            startBroadcast() {
                if (this.isBroadcasting) return;
                if (!this.currentSymbol) {
                    this.$message.warning('请先设置合约');
                    return;
                }

                this.wakeSpeech();
                if (this.broadcastInterval) clearInterval(this.broadcastInterval);

                if (this.currentPrice !== null) {
                    this.speakRound();
                } else {
                    this.statusMessage = '等待价格数据...';
                }

                this.broadcastInterval = setInterval(() => {
                    this.speakRound();
                }, this.intervalSeconds * 1000);

                this.isBroadcasting = true;
            },

            // 停止
            haltBroadcast() {
                if (this.broadcastInterval) {
                    clearInterval(this.broadcastInterval);
                    this.broadcastInterval = null;
                }
                window.speechSynthesis?.cancel();
                this.isBroadcasting = false;
                this.statusMessage = '播报已停止';
            },

            resetBroadcastInterval() {
                if (this.broadcastInterval) {
                    clearInterval(this.broadcastInterval);
                    this.broadcastInterval = setInterval(() => this.speakRound(), this.intervalSeconds * 1000);
                }
            },

            // 启用时间范围
            enableTimeRange() {
                if (!this.timeRangeStartTime || !this.timeRangeEndTime) {
                    this.$message.warning('请先设置开始时间和结束时间');
                    return;
                }
                if (this.timeRangeStartTime >= this.timeRangeEndTime) {
                    this.$message.error('开始时间必须早于结束时间');
                    return;
                }
                
                this.timeRangeEnabled = true;
                localStorage.setItem('time_range_start', this.timeRangeStartTime);
                localStorage.setItem('time_range_end', this.timeRangeEndTime);
                localStorage.setItem('time_range_enabled', 'true');
                this.$message.success(`时间范围已启用: ${this.timeRangeStartTime} - ${this.timeRangeEndTime}`);
            },

            // 停止时间范围
            stopTimeRange() {
                this.timeRangeEnabled = false;
                localStorage.setItem('time_range_enabled', 'false');
                this.$message.success('时间范围已停止');
            },

            saveSettings() {
                localStorage.setItem('interval_seconds', this.intervalSeconds.toString());
                localStorage.setItem('selected_voice', this.selectedVoice);
                if (this.isBroadcasting) this.resetBroadcastInterval();
                this.dialogVisible = false;
                this.$message.success('设置已保存');
            }
        },

        watch: {
            selectedVoice() {
                this.updateVoiceSelection();
            },
            intervalSeconds() {
                if (this.isBroadcasting) this.resetBroadcastInterval();
            },
            speakEnabled(val) {
                localStorage.setItem('speak_enabled', val);
            },
            timeRangeEnabled(val) {
                localStorage.setItem('time_range_enabled', val);
            }
        },

        beforeDestroy() {
            if (this.broadcastInterval) clearInterval(this.broadcastInterval);
            if (this.socket) {
                this.userInterrupted = true;
                this.socket.close();
            }
        }
    });
}
