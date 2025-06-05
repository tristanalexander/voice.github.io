class WhisperTranscriber {
    constructor() {
        this.isInitialized = false;
        this.isRecording = false;
        this.audioContext = null;
        this.mediaRecorder = null;
        this.stream = null;
        this.transcriber = null;
        this.transcriptionBuffer = '';
        this.lastTranscription = null; // For duplicate detection
        
        // Audio processing constants
        this.kSampleRate = 16000;
        this.kIntervalAudio_ms = 8000; // Process audio every 8 seconds for better quality
        
        // UI elements
        this.micSelect = document.getElementById('microphone-select');
        this.modelSelect = document.getElementById('model-select');
        this.startBtn = document.getElementById('start-btn');
        this.stopBtn = document.getElementById('stop-btn');
        this.clearBtn = document.getElementById('clear-btn');
        this.status = document.getElementById('status');
        this.output = document.getElementById('transcription-output');
        this.debugOutput = document.getElementById('debug-output');
        
        this.initializeApp();
    }
    
    async initializeApp() {
        try {
            this.updateStatus('Initializing...');
            await this.requestMicrophonePermission();
            await this.loadMicrophones();
            await this.initializeWhisper();
            this.setupEventListeners();
            this.updateStatus('Ready - Select microphone and click Start');
        } catch (error) {
            this.updateStatus('Initialization failed');
            this.logDebug('Initialization error: ' + error.message);
        }
    }
    
    async requestMicrophonePermission() {
        try {
            this.updateStatus('Requesting microphone permission...');
            this.logDebug('Requesting microphone access...');
            
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach(track => track.stop());
            
            this.logDebug('Microphone permission granted');
        } catch (error) {
            if (error.name === 'NotAllowedError') {
                throw new Error('Microphone permission denied. Please allow microphone access and refresh.');
            } else if (error.name === 'NotFoundError') {
                throw new Error('No microphone found. Please connect a microphone and refresh.');
            } else {
                throw new Error('Failed to access microphone: ' + error.message);
            }
        }
    }
    
    async loadMicrophones() {
        try {
            this.updateStatus('Loading microphones...');
            this.logDebug('Enumerating audio devices...');
            
            const devices = await navigator.mediaDevices.enumerateDevices();
            const audioInputs = devices.filter(device => device.kind === 'audioinput');
            
            this.logDebug(`Found ${audioInputs.length} audio input devices`);
            
            this.micSelect.innerHTML = '<option value="">Select microphone...</option>';
            
            audioInputs.forEach((device, index) => {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.textContent = device.label || `Microphone ${index + 1}`;
                this.micSelect.appendChild(option);
                this.logDebug(`Added microphone: ${option.textContent}`);
            });
            
            if (audioInputs.length === 0) {
                throw new Error('No microphones found');
            }
            
            if (audioInputs.length === 1) {
                this.micSelect.value = audioInputs[0].deviceId;
                this.startBtn.disabled = false;
                this.logDebug('Auto-selected single microphone');
            }
            
        } catch (error) {
            throw new Error('Failed to load microphones: ' + error.message);
        }
    }
    
    async initializeWhisper() {
        try {
            this.updateStatus('Loading Whisper model...');
            this.logDebug('Initializing Whisper via Transformers.js...');
            
            if (!window.transformers) {
                throw new Error('Transformers.js not loaded');
            }
            
            const modelName = this.getSelectedModel();
            this.logDebug(`Loading model: ${modelName}`);
            
            // Create the transcription pipeline
            this.transcriber = await window.transformers.pipeline(
                'automatic-speech-recognition',
                `Xenova/whisper-${modelName}`,
                {
                    chunk_length_s: 30,
                    stride_length_s: 5,
                }
            );
            
            this.isInitialized = true;
            this.updateCurrentMode(`Whisper ${modelName} (Local)`);
            this.logDebug('Whisper model loaded successfully');
            
        } catch (error) {
            this.logDebug('Whisper initialization failed: ' + error.message);
            throw new Error('Failed to initialize Whisper: ' + error.message);
        }
    }
    
    getSelectedModel() {
        return this.modelSelect.value;
    }
    
    setupEventListeners() {
        this.startBtn.addEventListener('click', () => this.startRecording());
        this.stopBtn.addEventListener('click', () => this.stopRecording());
        this.clearBtn.addEventListener('click', () => this.clearTranscription());
        
        this.micSelect.addEventListener('change', () => {
            this.startBtn.disabled = !this.micSelect.value || !this.isInitialized;
            this.logDebug(`Selected microphone: ${this.micSelect.options[this.micSelect.selectedIndex].text}`);
        });
        
        this.modelSelect.addEventListener('change', async () => {
            this.logDebug(`Selected model: ${this.getSelectedModel()}`);
            if (this.isInitialized) {
                this.updateStatus('Switching model...');
                await this.initializeWhisper();
                this.updateStatus('Ready - Select microphone and click Start');
            }
        });
    }
    
    async startRecording() {
        try {
            if (!this.micSelect.value) {
                this.showError('Please select a microphone first');
                return;
            }
            
            if (!this.transcriber) {
                this.showError('Whisper model not loaded. Please wait for initialization to complete.');
                return;
            }
            
            this.updateStatus('Starting recording...');
            this.logDebug('Starting real-time Whisper recording...');
            
            await this.startMicrophone();
            
            // Update UI
            this.isRecording = true;
            this.startBtn.disabled = true;
            this.stopBtn.disabled = false;
            this.stopBtn.classList.add('recording');
            this.output.classList.add('recording');
            this.micSelect.disabled = true;
            this.modelSelect.disabled = true;
            
            this.updateStatus('Recording... Speak now (Processing locally)');
            this.logDebug('Recording started successfully');
            
        } catch (error) {
            this.updateStatus('Failed to start recording');
            this.logDebug('Recording error: ' + error.message);
            this.resetUI();
        }
    }
    
    async startMicrophone() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    deviceId: this.micSelect.value,
                    sampleRate: this.kSampleRate,
                    channelCount: 1,
                    echoCancellation: false,
                    autoGainControl: true,
                    noiseSuppression: true,
                }
            });
            
            this.stream = stream;
            
            // Use Web Audio API for more reliable audio capture
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: this.kSampleRate
            });
            
            const source = this.audioContext.createMediaStreamSource(stream);
            
            // Create a script processor for continuous audio capture
            const bufferSize = 4096;
            this.scriptProcessor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
            
            this.audioBuffer = [];
            this.lastProcessTime = Date.now();
            
            this.scriptProcessor.onaudioprocess = (event) => {
                if (!this.isRecording) return;
                
                const inputBuffer = event.inputBuffer;
                const inputData = inputBuffer.getChannelData(0);
                
                // Accumulate audio data
                this.audioBuffer.push(...inputData);
                
                // Process every 8 seconds of audio
                const now = Date.now();
                if (now - this.lastProcessTime >= this.kIntervalAudio_ms) {
                    this.processAccumulatedAudio();
                    this.lastProcessTime = now;
                }
            };
            
            // Connect the audio pipeline
            source.connect(this.scriptProcessor);
            this.scriptProcessor.connect(this.audioContext.destination);
            
            this.logDebug('Web Audio API recording started');
            
        } catch (error) {
            throw new Error('Failed to start microphone: ' + error.message);
        }
    }
    
    async processAccumulatedAudio() {
        if (this.audioBuffer.length === 0) return;
        
        try {
            this.logDebug('Processing accumulated audio...');
            
            // Convert accumulated buffer to Float32Array
            const audioData = new Float32Array(this.audioBuffer);
            
            // Ensure we have enough audio data (at least 1 second)
            if (audioData.length < this.kSampleRate) {
                this.logDebug('Not enough audio data, skipping...');
                return;
            }
            
            // Reset error count on successful processing start
            this.errorCount = 0;
            
            // Run transcription
            const result = await this.transcriber(audioData, {
                chunk_length_s: 30,
                stride_length_s: 5,
                return_timestamps: false,
                language: 'english',
                task: 'transcribe'
            });
            
            if (result.text && result.text.trim().length > 0) {
                const text = result.text.trim();
                if (!this.isAudioArtifact(text) && !this.isDuplicateText(text)) {
                    this.appendTranscription(text);
                    this.logDebug(`Transcribed: "${text}"`);
                    
                    // Store last transcription for duplicate detection
                    this.lastTranscription = text;
                }
            }
            
            // Keep only small overlap to prevent repetitions (reduced from 2 seconds to 0.5 seconds)
            const keepSamples = this.kSampleRate * 0.5; // Keep 0.5 seconds for minimal context
            if (this.audioBuffer.length > keepSamples) {
                this.audioBuffer = this.audioBuffer.slice(-keepSamples);
            }
            
        } catch (error) {
            this.logDebug('Transcription error: ' + error.message);
            
            // Handle errors
            this.errorCount = (this.errorCount || 0) + 1;
            if (this.errorCount > 3) {
                this.logDebug('Too many transcription errors, restarting...');
                this.errorCount = 0;
                this.restartRecording();
            }
        }
    }
    
    // Process any remaining audio when recording stops
    async processRemainingAudio() {
        if (this.audioBuffer && this.audioBuffer.length > this.kSampleRate * 0.5) {
            this.logDebug('Processing remaining audio before stopping...');
            await this.processAccumulatedAudio();
        }
    }
    
    // Check for duplicate transcriptions to reduce repetition
    isDuplicateText(newText) {
        if (!this.lastTranscription) return false;
        
        // Calculate similarity between new text and last transcription
        const similarity = this.calculateTextSimilarity(newText, this.lastTranscription);
        
        // If more than 60% similar, consider it a duplicate
        if (similarity > 0.6) {
            this.logDebug(`Detected duplicate text (${(similarity * 100).toFixed(1)}% similar), skipping...`);
            return true;
        }
        
        return false;
    }
    
    // Simple text similarity calculation
    calculateTextSimilarity(text1, text2) {
        const words1 = text1.toLowerCase().split(/\s+/);
        const words2 = text2.toLowerCase().split(/\s+/);
        
        // Count common words
        let commonWords = 0;
        for (const word of words1) {
            if (words2.includes(word)) {
                commonWords++;
            }
        }
        
        // Return similarity ratio
        const maxLength = Math.max(words1.length, words2.length);
        return maxLength > 0 ? commonWords / maxLength : 0;
    }
    
    async restartRecording() {
        if (!this.isRecording) return;
        
        try {
            this.logDebug('Restarting recording due to audio errors...');
            
            // Stop current Web Audio API components
            if (this.scriptProcessor) {
                this.scriptProcessor.disconnect();
                this.scriptProcessor = null;
            }
            
            if (this.audioContext && this.audioContext.state !== 'closed') {
                this.audioContext.close();
                this.audioContext = null;
            }
            
            if (this.stream) {
                this.stream.getTracks().forEach(track => track.stop());
                this.stream = null;
            }
            
            // Clear audio buffer
            this.audioBuffer = [];
            
            // Wait a moment
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Restart if still recording
            if (this.isRecording) {
                await this.startMicrophone();
                this.logDebug('Recording restarted successfully');
            }
            
        } catch (error) {
            this.logDebug('Failed to restart recording: ' + error.message);
            this.stopRecording();
        }
    }
    
    // Helper function to filter out audio artifacts
    isAudioArtifact(text) {
        const artifacts = [
            '[BLANK_AUDIO]',
            '[MUSIC]',
            '[NOISE]',
            '♪',
            'Thank you.',
            'Thanks for watching.',
            'Bye.',
            'Goodbye.'
        ];
        
        const lowerText = text.toLowerCase().trim();
        
        // Filter very short utterances
        if (lowerText.length < 3) return true;
        
        // Filter common artifacts
        return artifacts.some(artifact => 
            lowerText.includes(artifact.toLowerCase())
        );
    }
    
    async stopRecording() {
        try {
            this.logDebug('Stopping recording...');
            this.isRecording = false;
            
            // Process any remaining audio before stopping
            await this.processRemainingAudio();
            
            // Stop Web Audio API components
            if (this.scriptProcessor) {
                this.scriptProcessor.disconnect();
                this.scriptProcessor = null;
            }
            
            if (this.audioContext && this.audioContext.state !== 'closed') {
                this.audioContext.close();
                this.audioContext = null;
            }
            
            if (this.stream) {
                this.stream.getTracks().forEach(track => track.stop());
                this.stream = null;
            }
            
            // Clear audio buffer
            this.audioBuffer = [];
            this.lastTranscription = null; // Reset duplicate detection
            
            this.resetUI();
            this.updateStatus('Recording stopped');
            this.logDebug('Recording stopped successfully');
            
        } catch (error) {
            this.logDebug('Stop recording error: ' + error.message);
        }
    }
    
    resetUI() {
        this.startBtn.disabled = !this.micSelect.value || !this.isInitialized;
        this.stopBtn.disabled = true;
        this.stopBtn.classList.remove('recording');
        this.output.classList.remove('recording');
        this.micSelect.disabled = false;
        this.modelSelect.disabled = false;
    }
    
    appendTranscription(text) {
        if (this.output.textContent === 'Transcribed text will appear here...') {
            this.output.textContent = '';
            this.transcriptionBuffer = '';
        }
        
        // Append new text
        this.transcriptionBuffer += text + ' ';
        this.output.textContent = this.transcriptionBuffer;
        
        // Auto-scroll to bottom
        this.output.scrollTop = this.output.scrollHeight;
    }
    
    clearTranscription() {
        this.transcriptionBuffer = '';
        this.output.textContent = 'Transcribed text will appear here...';
        this.logDebug('Transcription cleared');
    }
    
    updateStatus(message) {
        this.status.innerHTML = `Status: <strong>${message}</strong>`;
    }
    
    updateCurrentMode(mode) {
        const currentModeElement = document.getElementById('current-mode');
        if (currentModeElement) {
            currentModeElement.textContent = mode;
        }
    }
    
    showError(message) {
        // Create a temporary error message element
        const errorDiv = document.createElement('div');
        errorDiv.className = 'error-message';
        errorDiv.textContent = message;
        errorDiv.style.cssText = `
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: #ef4444;
            color: white;
            padding: 12px 24px;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            z-index: 1000;
            font-weight: 500;
        `;
        
        document.body.appendChild(errorDiv);
        
        // Remove after 4 seconds
        setTimeout(() => {
            if (errorDiv.parentNode) {
                errorDiv.parentNode.removeChild(errorDiv);
            }
        }, 4000);
    }
    
    logDebug(message) {
        const timestamp = new Date().toLocaleTimeString();
        this.debugOutput.textContent += `[${timestamp}] ${message}\n`;
        this.debugOutput.scrollTop = this.debugOutput.scrollHeight;
        
        // Show debug section if there are messages
        if (this.debugOutput.textContent.trim()) {
            document.querySelector('.debug-section').style.display = 'block';
        }
        
        // Only log to console in development
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
            console.log(`[WhisperTranscriber] ${message}`);
        }
    }
}

// Initialize the application
new WhisperTranscriber(); 