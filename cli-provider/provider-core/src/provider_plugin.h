#ifndef PROVIDER_PLUGIN_H
#define PROVIDER_PLUGIN_H

#include <QObject>
#include <QMap>
#include <QSet>
#include <QString>
#include <QTimer>
#include <QVariant>
class QJsonObject;
#include "provider_interface.h"
#include "inference_identity.h"
#include "logos_api.h"
#include "logos_api_client.h"
#include "logos_object.h"
#include "logos_sdk.h"

class ProviderPlugin : public QObject, public ProviderInterface
{
    Q_OBJECT
    Q_PLUGIN_METADATA(IID ProviderInterface_iid FILE "metadata.json")
    Q_INTERFACES(ProviderInterface PluginInterface)

public:
    explicit ProviderPlugin(QObject* parent = nullptr);
    ~ProviderPlugin() override;

    QString name() const override { return "inference_provider"; }
    QString version() const override { return "0.1.0"; }

    Q_INVOKABLE void initLogos(LogosAPI* api);

    Q_INVOKABLE bool    start(const QString& room) override;
    Q_INVOKABLE bool    stop() override;
    Q_INVOKABLE QString stats() override;
    Q_INVOKABLE QString providerId() override;

    Q_INVOKABLE QString identityStatus() override;
    Q_INVOKABLE QString createAccount(const QString& passphrase) override;
    Q_INVOKABLE bool    importAccount(const QString& mnemonic,
                                      const QString& passphrase) override;

signals:
    void eventResponse(const QString& eventName, const QVariantList& args);

private:
    void    ensureIdentity();
    void    scheduleAnnounce();
    void    sendAnnounce();
    void    sendCard(const QString& signPk, const QString& boxPk, int load);
    QString topicForRoom(const QString& room) const;
    QString sessionTopic() const;
    void    handleMessageReceived(const QVariantList& data);
    void    runInference(const QString& id, const QString& replyPkB64,
                         const QString& prompt, const QString& model,
                         const QString& topic);
    void    sendResponse(const QString& id, const QString& replyPkB64,
                         const QString& text, const QString& model,
                         const QString& topic);
    bool    powValid(const QString& promptId, const QString& nonce) const;
    // Per-session prepay: a prompt is served if its cred names a session whose
    // one-time payment we've seen land on m_payTo and whose prompt quota isn't
    // spent. Mutates session bookkeeping, so it's non-const.
    bool    sessionEligible(const QJsonObject& cred);
    double  seqBalance();          // m_payTo balance via sequencer RPC (-1 on error)
    bool    invokeBool(const char* what, const QString& method,
                       const QVariant& arg = QVariant());

    QString          m_id;
    QString          m_room;
    QString          m_model;       // default ollama model (first of m_models)
    QStringList      m_models;      // all models served (INFERENCE_MODELS csv)
    QString          m_access;      // "open" | "pow" | "lez" (INFERENCE_ACCESS)
    int              m_powBits = 18;  // hashcash difficulty (INFERENCE_POW_BITS)
    QString          m_payTo;       // provider LEZ PUBLIC account, hex (INFERENCE_PAY_TO)
    QString          m_payToB58;    // m_payTo encoded base58 for the sequencer RPC
    QString          m_seq;         // LEZ sequencer URL (LEZ_SEQUENCER)
    double           m_rate = 1.0;  // stream draw, TokensPerSecond (INFERENCE_RATE)
    QString          m_payBackend;  // "mock" | "lez" (INFERENCE_PAY_BACKEND)
    // Per-session prepay bookkeeping (INFERENCE_PAY_BACKEND=lez).
    int              m_quota = 10;          // prompts unlocked per paid session
    double           m_startBalance = -1.0; // m_payTo balance when we went live
    double           m_confirmedTotal = 0.0;// Σ amounts of confirmed sessions
    QMap<QString,int> m_sessions;           // session amount(key) → prompts used
    double           m_priceAmount = 0.0;       // price per unit (0 = free)
    QString          m_priceUnit;               // "request" | "1ktokens"
    QString          m_priceAsset;              // LEZ asset id (empty until LEZ)
    QString          m_ollamaUrl;   // OLLAMA_URL, default http://localhost:11434
    bool             m_started        = false;
    bool             m_createNodeDone = false;
    int              m_promptsSeen    = 0;
    int              m_responsesSent  = 0;
    int              m_inflight       = 0;   // prompts being answered right now
    int              m_maxInflight    = 4;   // concurrency cap (INFERENCE_MAX_INFLIGHT)
    QSet<QString>    m_inflightIds;           // ids currently being answered (dedup)
    QString          m_lastPromptId;
    QString          m_lastFrom;
    QTimer*          m_announceTimer  = nullptr;

    LogosAPIClient*  m_deliveryClient = nullptr;
    LogosObject*     m_deliveryObject = nullptr;
    InferenceIdentity* m_identity     = nullptr;
};

#endif
