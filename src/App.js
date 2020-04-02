/*global platformClient*/

import React, { Component } from 'react';
import Loading from "./Loading";
import _ from 'lodash';
import StatusTimer from "./StatusTimer";
import FormControlLabel from "@material-ui/core/FormControlLabel";
import Switch from "@material-ui/core/Switch";
import {withStyles} from '@material-ui/core/styles';
import FiberManualRecordIcon from '@material-ui/icons/FiberManualRecord';
import moment from 'moment';
import Fab from "@material-ui/core/Fab";
import RefreshIcon from "@material-ui/icons/Refresh";
import CircularProgress from '@material-ui/core/CircularProgress';
import { blue} from '@material-ui/core/colors';
import ReactInterval from "react-interval";


const styles = theme => ({
    root: {
        padding: theme.spacing(2),
    },
    switch: {
        margin: theme.spacing(2),
    },
    status: {
        margin: theme.spacing(2),
    },
    recording: {
        textAlign: 'center',
        margin: theme.spacing(2),
        color: 'red',
        fontWeight: 600,
        fontSize: 32
    },
    refresh: {
        position: 'fixed',
        top: theme.spacing(2),
        right: theme.spacing(2)
    },
    fabProgressWrapper: {
        margin: theme.spacing(1),
        position: 'relative',
    },
    fabProgress: {
        color: blue[500],
        position: 'absolute',
        top: -6,
        left: -6,
        zIndex: 1,
    },
});

const clientId = process.env.REACT_APP_PURECLOUD_CLIENT_ID;
let client,notificationsApi,presenceApi,usersApi,webSocket,notificationChannel;

class App extends Component {
    constructor(props) {
        super(props);
        this.state = {
            isLoading: true,
            presences: [],
            userPresenceTopic: '',
            userConversationsTopic: '',
            userId: '',
            presenceTime: null,
            currentPresence: null,
            formattedTime: '',
            autoRecordInternal: false,
            showStatusTimer: true,
            activeRecordings: [],
            expires: null,
            lastHeartbeat: moment()
        };
    }

    componentDidMount() {
        this.load();
    }

    load() {
        const redirectUri = window.location.href;

        client = platformClient.ApiClient.instance;
        notificationsApi = new platformClient.NotificationsApi();
        presenceApi = new platformClient.PresenceApi();
        usersApi = new platformClient.UsersApi();

        // Set PureCloud settings
        client.setEnvironment('mypurecloud.com');
        client.setPersistSettings(true, 'pc_supervisor');

        // Local vars
        let presences = {};
        let currentPresence = '';
        let userPresenceTopic = '';
        let userConversationsTopic = '';
        let me, presenceTime;

        client.loginImplicitGrant(clientId, redirectUri)
            .then(() => {
                console.log('Logged in');

                // Get presences
                return presenceApi.getPresencedefinitions({ pageSize: 100 });
            })
            .then((presenceListing) => {
                console.log(`Found ${presenceListing.entities.length} presences`);
                presences = presenceListing.entities;

                // Get authenticated user's data, including current presence
                return usersApi.getUsersMe({ expand: ['presence'] });
            })
            .then((userMe) => {
                me = userMe;
                currentPresence = this.getPresenceById(presences,me.presence.presenceDefinition.id);
                presenceTime = me.presence.modifiedDate;
                userPresenceTopic = `v2.users.${me.id}.presence`;
                userConversationsTopic = `v2.users.${me.id}.conversations`;
                const topics = [ { id: userPresenceTopic }, { id: userConversationsTopic } ];
                this.setState({userPresenceTopic,userConversationsTopic,currentPresence,presences,presenceTime}, () => this.subscribeToNotifications(topics))
            })
            .catch((err) => {
                return console.error(err);
            });
    }

    subscribeToNotifications(topics) {
        let expires;
        notificationsApi.postNotificationsChannels()
            .then((channel) => {
                console.log('channel: ', channel);
                notificationChannel = channel;
                expires = channel.expires;
                // Set up web socket
                webSocket = new WebSocket(notificationChannel.connectUri);
                webSocket.onmessage = (m) => this.handleNotification(m);
                // webSocket.onopen = () => {
                //     webSocket.send("{\"message\":\"ping\"}");
                // };

                // Subscribe to authenticated user's presence
                return notificationsApi.putNotificationsChannelSubscriptions(notificationChannel.id, topics);
            })
            .then((channel) => {
                console.log('Channel subscriptions set successfully');
                this.setState({isLoading: false, expires})
            })
            .catch((err) => console.error(err));
    }

    handleSwitchChange(e){
        const field = e.target.name;
        const value = this.state[field];

        this.setState({[field]: !value});
    }

    recordCall(conversationId, participantId) {
        const activeRecordings = this.state.activeRecordings;
        if((notificationsApi||null) === null){
            notificationsApi = new platformClient.ConversationsApi();
        }

        const body = {recording:true}; // Object | Conversation

        notificationsApi.patchConversationsCallParticipant(conversationId, participantId, body)
            .then((data) => {
                console.log(`patchConversationsCall success! data: ${JSON.stringify(data, null, 2)}`);
                activeRecordings.push(conversationId);
                this.setState({activeRecordings});
            })
            .catch((err) => {
                console.log('There was a failure calling patchConversationsCall');
                console.error(err);
            });
    }

    getPresenceById(presences,id){
        const presence = _.find(presences, { 'id': id });
        if((presence||null) !== null){
            return presence.languageLabels.en_US;
        }

        return '';
    }

    // Handle incoming PureCloud notification from WebSocket
    handleNotification(message) {
        // Parse notification string to a JSON object
        const notification = JSON.parse(message.data);
        const userPresenceTopic = this.state.userPresenceTopic || '';
        const userConversationsTopic = this.state.userConversationsTopic || '';
        const presences = this.state.presences;

        // Discard unwanted notifications
        if (notification.topicName.toLowerCase() === 'channel.metadata') {
            // Heartbeat
            console.info('Heartbeat metadata or pong: ', notification);
            this.setState({lastHeartbeat: moment()});
        } else if (notification.topicName.toLowerCase() === userPresenceTopic.toLowerCase()) {
            // Set current presence text in UI
            console.debug('Presence notification: ', notification);
            const currentPresence = this.getPresenceById(presences, notification.eventBody.presenceDefinition.id);
            this.setState({currentPresence, presenceTime: notification.eventBody.modifiedDate});
        } else if (notification.topicName.toLowerCase() === userConversationsTopic.toLowerCase()) {
            console.debug('Conversation notification: ', notification);
            const eventBody = notification.eventBody;
            const participants = eventBody.participants;
            const id = eventBody.id;
            const activeRecordings = this.state.activeRecordings;
            const activeRecording = _.indexOf(this.state.activeRecordings,id);
            if(activeRecording === -1){
                const internal = _.filter(participants,
                    (p) => {
                        return !_.isNil(p.userId) &&
                            p.calls[0].state === 'connected' &&
                            p.calls[0].held === false &&
                            p.calls[0].recording === false
                });

                if(internal.length === 2 && this.state.autoRecordInternal){
                    const pi = _.find(internal,{userId: this.state.userId});
                    if(!_.isNil(pi)){
                        this.recordCall(id, pi.id);
                    }
                }
            } else {
                const internal = _.filter(participants, (p) => { return !_.isNil(p.endTime) });

                if(internal.length === 2){
                    activeRecordings.splice(activeRecording,1);
                    this.setState({activeRecordings});
                }
            }
        } else {
            console.warn('Unknown notification: ', notification);
        }
    }

    ping(){
        console.log('sending ping...');
        webSocket.send("{\"message\":\"ping\"}");
    }

    reload() {
        const userPresenceTopic = this.state.userPresenceTopic || null;
        const userConversationsTopic = this.state.userConversationsTopic || null;

        if((notificationChannel||null) !== null && userPresenceTopic !== null && userConversationsTopic !== null){
            this.setState({isLoading: true}, () => {
                notificationsApi.deleteNotificationsChannelSubscriptions(notificationChannel.id)
                    .then(() => {
                        console.log('deleteNotificationsChannelSubscriptions returned successfully.');
                        const topics = [ { id: userPresenceTopic }, { id: userConversationsTopic } ];
                        this.setState({isLoading: false},() => this.subscribeToNotifications(topics));
                    })
                    .catch((err) => {
                        console.log('There was a failure calling deleteNotificationsChannelSubscriptions');
                        console.error(err);
                        this.setState({isLoading: false});
                    });
            })
        }
    }

    healthCheck() {
        const {expires,lastHeartbeat} = this.state;
        const now = moment();
        const exp = moment(expires);
        const minutes  = exp.diff(now, 'minutes');
        if(minutes < 5){
            this.reload();
        } else {
            const seconds = now.diff(lastHeartbeat, 'seconds');
            if(seconds > 30){
                this.ping();
            }
        }
    }

    render() {
        const {classes} = this.props;

        const {
            isLoading,
            presenceTime,
            currentPresence,
            autoRecordInternal,
            showStatusTimer,
            activeRecordings
        } = this.state;

        return (
            <div>
                {isLoading ? (
                    <Loading/>
                ) : (
                    <div className={classes.root}>
                        <FormControlLabel
                            className={classes.switch}
                            control={
                                <Switch
                                    name="autoRecordInternal"
                                    checked={autoRecordInternal}
                                    onChange={(e) => this.handleSwitchChange(e)}
                                    color="primary"
                                />
                            }
                            label="Auto Record Internal Calls?"
                        />
                        <FormControlLabel
                            className={classes.switch}
                            control={
                                <Switch
                                    name="showStatusTimer"
                                    checked={showStatusTimer}
                                    onChange={(e) => this.handleSwitchChange(e)}
                                    color="primary"
                                />
                            }
                            label="Show Status Timer?"
                        />
                        <br/>
                        {activeRecordings.length > 0 &&
                        <div className={classes.recording}>
                            <FiberManualRecordIcon/> <span>Recording Call</span>
                        </div>
                        }
                        <br/>
                        {showStatusTimer &&
                        <div className={classes.status}>
                            <StatusTimer presenceTime={presenceTime} currentPresence={currentPresence}/>
                        </div>
                        }
                    </div>
                )}
                <div className={classes.refresh}>
                    <div className={classes.fabProgressWrapper}>
                        <Fab
                            aria-label="reload"
                            onClick={() => this.reload()}
                            disabled={isLoading}
                        >
                            <RefreshIcon/>
                        </Fab>
                        {isLoading && <CircularProgress size={68} className={classes.fabProgress} />}
                    </div>
                    <ReactInterval timeout={60000} enabled={true} callback={() => this.healthCheck()} />
                </div>
            </div>
        );
    }
}

export default withStyles(styles)(App);