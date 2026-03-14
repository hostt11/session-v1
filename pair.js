import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, Browsers, jidNormalizedUser, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { upload } from './mega.js';
import NodeCache from 'node-cache'; // Ajoutez cette dépendance

const router = express.Router();
const msgRetryCounterCache = new NodeCache(); // Cache pour les retry

// Ensure the session directory exists
function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
    } catch (e) {
        console.error('Error removing file:', e);
    }
}

// Fonction pour nettoyer le numéro
const formatPhoneNumber = (number) => {
    if (!number) return '';
    // Enlever tous les caractères non numériques
    let cleaned = number.replace(/[^0-9]/g, '');
    // S'assurer que le numéro commence par le code pays (sans +)
    if (cleaned.startsWith('0')) {
        cleaned = '237' + cleaned.substring(1); // Remplacer 237 par votre code pays par défaut
    }
    return cleaned;
};

router.get('/', async (req, res) => {
    let num = req.query.number;
    let dirs = './' + (num || `session-${Date.now()}`);
    
    // Formater le numéro
    num = formatPhoneNumber(num);
    
    if (!num || num.length < 10) {
        return res.status(400).send({ 
            error: 'Numéro invalide. Format attendu: 237XXXXXXXX (avec code pays)' 
        });
    }
    
    console.log(`Tentative de connexion pour: ${num}`);
    
    // Remove existing session if present
    await removeFile(dirs);
    
    async function initiateSession() {
        try {
            // Récupérer la dernière version de Baileys
            const { version, isLatest } = await fetchLatestBaileysVersion();
            console.log(`Utilisation de WA version: ${version}, isLatest: ${isLatest}`);
            
            const { state, saveCreds } = await useMultiFileAuthState(dirs);

            // Configuration avancée du socket
            const sock = makeWASocket({
                version: version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
                },
                printQRInTerminal: false,
                logger: pino({ level: "silent" }),
                browser: Browsers.ubuntu('Chrome'), // Utiliser le browser standard
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false,
                msgRetryCounterCache: msgRetryCounterCache,
                defaultQueryTimeoutMs: 60000,
                keepAliveIntervalMs: 30000,
                patchMessageBeforeSending: (msg) => {
                    // Optionnel: modifier les messages avant envoi
                    return msg;
                },
                // Options de connexion importantes
                connectTimeoutMs: 60000,
                retryRequestDelayMs: 5000,
                maxMsgRetryCount: 5,
                fireInitQueries: true,
                shouldSyncHistoryMessage: false,
                // Éviter de signaler qu'on est en ligne constamment
                emitOwnEvents: false,
            });

            // Attendre que l'auth soit prête
            await delay(2000);

            if (!sock.authState.creds.registered) {
                console.log(`Demande de code de pairage pour: ${num}`);
                
                try {
                    // Nettoyer le numéro pour WhatsApp
                    const cleanNum = num.replace(/[^0-9]/g, '');
                    
                    // Demander le code de pairage avec gestion d'erreur
                    const response = await sock.requestPairingCode(cleanNum);
                    
                    if (response) {
                        console.log({ num: cleanNum, code: response });
                        
                        // Formater le code pour meilleure lisibilité
                        const formattedCode = response.match(/.{1,4}/g)?.join('-') || response;
                        
                        if (!res.headersSent) {
                            await res.send({ 
                                code: response,
                                formattedCode: formattedCode,
                                message: 'Code de pairage généré avec succès' 
                            });
                        }
                    }
                } catch (pairError) {
                    console.error('Erreur lors de la demande de code:', pairError);
                    
                    if (!res.headersSent) {
                        res.status(500).send({ 
                            error: 'Erreur lors de la génération du code',
                            details: pairError.message 
                        });
                    }
                    
                    // Nettoyer en cas d'erreur
                    await removeFile(dirs);
                    return;
                }
            }

            // Gérer les mises à jour de creds
            sock.ev.on('creds.update', saveCreds);
            
            // Gérer les mises à jour de connexion
            sock.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect, qr } = update;
                
                console.log("Connection update:", connection, lastDisconnect?.error?.message);

                if (qr) {
                    console.log("QR Code reçu (non utilisé pour le pairage)");
                }

                if (connection === "open") {
                    console.log("Connexion ouverte avec succès!");
                    
                    try {
                        await delay(5000); // Attendre que tout soit prêt
                        
                        // Lire le fichier de session
                        const sessionGlobal = fs.readFileSync(dirs + '/creds.json');
                        
                        // Générer un ID unique pour le fichier Mega
                        const randomId = Date.now().toString(36) + Math.random().toString(36).substring(2);
                        
                        // Upload vers Mega
                        console.log("Upload de la session vers Mega...");
                        const megaUrl = await upload(
                            fs.createReadStream(`${dirs}/creds.json`), 
                            `session_${randomId}.json`
                        );
                        
                        // Extraire l'ID de session
                        let sessionId = megaUrl.replace('https://mega.nz/file/', '');
                        
                        // Envoyer l'ID au numéro
                        const userJid = jidNormalizedUser(num + '@s.whatsapp.net');
                        
                        await sock.sendMessage(userJid, { 
                            text: `*SESSION ID:*\n\`\`\`${sessionId}\`\`\`\n\n*NE PARTAGEZ PAS CE CODE*` 
                        });
                        
                        await delay(1000);
                        
                        // Message de bienvenue
                        await sock.sendMessage(userJid, { 
                            text: '👋 *HELLO THERE!*\n\n' +
                                  '✅ Votre session a été créée avec succès\n' +
                                  '🔒 NE PARTAGEZ PAS VOTRE SESSION ID\n' +
                                  '📝 Utilisez l\'ID ci-dessus dans votre variable SESSION_ID\n\n' +
                                  '📢 Rejoignez notre chaîne: https://whatsapp.com/channel/...\n' +
                                  'Merci d\'utiliser notre bot! 🤖' 
                        });
                        
                        console.log("Messages envoyés avec succès!");
                        
                        // Nettoyer après envoi
                        await delay(2000);
                        await removeFile(dirs);
                        
                        // Fermer la connexion proprement
                        try {
                            sock.ws.close();
                        } catch (e) {}
                        
                        process.exit(0);
                        
                    } catch (sendError) {
                        console.error("Erreur lors de l'envoi des messages:", sendError);
                        await removeFile(dirs);
                        process.exit(1);
                    }
                    
                } else if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const errorMessage = lastDisconnect?.error?.message || 'Unknown error';
                    
                    console.log(`Connexion fermée. Code: ${statusCode}, Message: ${errorMessage}`);
                    
                    // Ne pas réessayer si c'est une erreur 405 ou 401
                    if (statusCode === 405) {
                        console.log("Erreur 405: Méthode non autorisée. WhatsApp bloque probablement cette IP.");
                        
                        if (!res.headersSent) {
                            res.status(503).send({ 
                                error: 'WhatsApp bloque les requêtes depuis cette IP. Essayez plus tard ou utilisez un VPN.',
                                code: 'IP_BLOCKED'
                            });
                        }
                        
                        await removeFile(dirs);
                        return;
                    }
                    
                    if (statusCode !== 401) {
                        console.log("Tentative de reconnexion dans 10s...");
                        await delay(10000);
                        
                        // Nettoyer et recommencer
                        await removeFile(dirs);
                        initiateSession();
                    }
                }
            });
            
        } catch (err) {
            console.error('Erreur lors de l\'initialisation:', err);
            
            if (!res.headersSent) {
                res.status(503).send({ 
                    error: 'Service temporairement indisponible',
                    details: err.message 
                });
            }
            
            await removeFile(dirs);
        }
    }

    // Timeout global
    const timeout = setTimeout(() => {
        if (!res.headersSent) {
            res.status(408).send({ error: 'Délai d\'attente dépassé' });
        }
        removeFile(dirs);
    }, 60000); // 60 secondes max

    try {
        await initiateSession();
    } finally {
        clearTimeout(timeout);
    }
});

// Gestionnaire d'erreurs global
process.on('uncaughtException', (err) => {
    console.log('Exception non capturée:', err);
});

process.on('unhandledRejection', (err) => {
    console.log('Rejection non gérée:', err);
});

export default router;
